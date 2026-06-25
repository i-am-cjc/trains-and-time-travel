const AMBULANCE_CREW_SIZE = 2;
const AMBULANCE_RESPONSE_DISTANCE = 3;
const AMBULANCE_SPAWN_X = 72;
const AMBULANCE_ROAD_Y = 30;
const BLOCKED_REDISPATCH_DELAY_MINUTES = 20;

export function isParamedic(npc) {
  return npc.profile.role === 'paramedic';
}

export function createAmbulanceLogic({
  getState,
  getElapsedMinutes,
  maps,
  writeLog,
  killPlayer,
  nextVehicleStepToward,
  nextStepToward,
  manhattanDistance,
  tileAtFor,
  npcAtOnMap,
  uniquePoints,
  neighborsOf,
  closestPoint,
  positionKey,
  carAtOnMap,
  onCorpseCollected,
  onAmbulanceDispatched,
}) {
  function updateAmbulanceResponse() {
    const state = getState();
    const waitingCorpse = nextWaitingCorpse();
    if (!waitingCorpse) return;
    if (state.minutesElapsed < state.nextAmbulanceDispatchMinute) return;
    const activeResponse = state.ambulances.some((ambulance) => ambulance.corpseId === waitingCorpse.id && ambulance.status !== 'leaving');
    if (!activeResponse) dispatchAmbulance(waitingCorpse);
  }

  function dispatchAmbulance(corpse) {
    const state = getState();
    if (state.ambulances.some((ambulance) => ambulance.status === 'responding')) return;
    const ambulance = {
      id: `ambulance-${state.nextAmbulanceId}`,
      mapKey: corpse.mapKey,
      x: AMBULANCE_SPAWN_X,
      y: AMBULANCE_ROAD_Y,
      dx: 1,
      sprite: 'ambulance',
      status: 'responding',
      corpseId: corpse.id,
      targetCorpse: { ...corpse },
    };
    state.nextAmbulanceId += 1;
    state.ambulances.push(ambulance);
    state.nextAmbulanceDispatchMinute = state.minutesElapsed;
    onAmbulanceDispatched(corpse);
    writeLog('An ambulance siren rises from the road and speeds toward the body.');
  }

  function moveAmbulances() {
    const state = getState();
    state.ambulances = state.ambulances
      .map((ambulance) => moveAmbulance(ambulance))
      .filter((ambulance) => ambulance.x >= 0 && ambulance.x < maps[ambulance.mapKey].width);

    if (state.currentMapKey !== 'station') return false;
    const hitAmbulance = ambulanceAt(state.player.x, state.player.y);
    if (!hitAmbulance) return false;
    killPlayer('An ambulance clips you while racing to an emergency, and the loop jolts back.');
    return true;
  }

  function moveAmbulance(ambulance) {
    if (ambulance.status === 'leaving') return { ...ambulance, x: ambulance.x + 1 };
    if (ambulance.status === 'returning') return moveAmbulanceBackToRoad(ambulance);
    if (ambulance.status === 'deployed') return ambulance;

    const corpse = corpseById(ambulance.corpseId);
    if (!corpse) return { ...ambulance, status: 'returning' };
    const step = nextVehicleStepToward({ ...ambulance, target: corpse });
    if (!step) return ambulance;
    const moved = { ...ambulance, ...step, targetCorpse: { ...corpse } };
    if (manhattanDistance(moved, corpse) <= AMBULANCE_RESPONSE_DISTANCE) {
      deployParamedics(moved);
      writeLog('The ambulance brakes nearby and two paramedics rush out with a stretcher.');
      return { ...moved, status: 'deployed' };
    }
    return moved;
  }

  function deployParamedics(ambulance) {
    const state = getState();
    const spawnPoints = uniquePoints([ambulance, ...neighborsOf(ambulance), ...neighborsOf({ x: ambulance.x + 1, y: ambulance.y })])
      .filter((point) => !tileAtFor(ambulance.mapKey, point.x, point.y).blocks && !npcAtOnMap(ambulance.mapKey, point.x, point.y) && !carAtOnMap(ambulance.mapKey, point.x, point.y));
    for (let index = 0; index < AMBULANCE_CREW_SIZE; index += 1) {
      const point = spawnPoints[index % spawnPoints.length] ?? ambulance;
      state.npcs.push(createParamedicState(ambulance, point, index));
    }
  }

  function createParamedicState(ambulance, point, index) {
    const profile = {
      key: `paramedic-${ambulance.id}-${index}`,
      name: `Paramedic ${index + 1}`,
      age: 32 + index,
      gender: index % 2 ? 'male' : 'female',
      role: 'paramedic',
      goal: 'collect the body and return to the ambulance',
      dialogue: ['The paramedic says, “Give us room to work.”'],
    };
    return { x: point.x, y: point.y, mapKey: ambulance.mapKey, mapSymbol: 'A', profile, route: [point, point], target: { ...ambulance.targetCorpse }, homeAmbulanceId: ambulance.id, assignedCorpseId: ambulance.corpseId, pendingDoorActions: [] };
  }

  function updateParamedicCollection() {
    const state = getState();
    state.ambulances.forEach((ambulance) => {
      if (ambulance.status !== 'deployed') return;
      const corpse = corpseById(ambulance.corpseId);
      const crew = state.npcs.filter((npc) => npc.homeAmbulanceId === ambulance.id);
      if (corpse) {
        crew.forEach((npc) => { npc.target = { x: corpse.x, y: corpse.y }; });
        const collecting = crew.some((npc) => npc.mapKey === corpse.mapKey && manhattanDistance(npc, corpse) <= 1);
        if (collecting) {
          state.corpses = state.corpses.filter((candidate) => candidate.id !== corpse.id);
          crew.forEach((npc) => { npc.target = { x: ambulance.x, y: ambulance.y }; });
          onCorpseCollected(corpse);
          writeLog('The paramedics lift the body onto a stretcher and carry it back to the ambulance.');
        }
        return;
      }
      crew.forEach((npc) => { npc.target = { x: ambulance.x, y: ambulance.y }; });
      removeParamedicsAtAmbulance(ambulance);
      if (!state.npcs.some((npc) => npc.homeAmbulanceId === ambulance.id)) {
        ambulance.status = 'returning';
        writeLog('The paramedics climb aboard and the ambulance heads back to the road.');
      }
    });
  }

  function removeParamedicsAtAmbulance(ambulance) {
    const state = getState();
    state.npcs = state.npcs.filter((npc) => (
      npc.homeAmbulanceId !== ambulance.id
      || npc.mapKey !== ambulance.mapKey
      || npc.x !== ambulance.x
      || npc.y !== ambulance.y
    ));
  }

  function returningAmbulanceFor(npc) {
    const state = getState();
    if (!isParamedic(npc) || corpseById(npc.assignedCorpseId)) return null;
    return state.ambulances.find((ambulance) => ambulance.id === npc.homeAmbulanceId && ambulance.status === 'deployed') ?? null;
  }

  function nextParamedicStep(npc, occupied) {
    const step = nextStepToward(npc, occupied, { avoidFire: false }) ?? null;
    if (!step && (npc.x !== npc.target.x || npc.y !== npc.target.y)) markAmbulanceCrewBlocked(npc);
    return step;
  }

  function markAmbulanceCrewBlocked(npc) {
    const state = getState();
    const ambulance = state.ambulances.find((candidate) => candidate.id === npc.homeAmbulanceId);
    if (!ambulance || ambulance.status !== 'deployed' || ambulance.blockedReturn) return;
    ambulance.blockedReturn = true;
    ambulance.status = 'returning';
    state.nextAmbulanceDispatchMinute = getElapsedMinutes() + BLOCKED_REDISPATCH_DELAY_MINUTES;
    state.npcs = state.npcs.filter((candidate) => candidate.homeAmbulanceId !== ambulance.id);
    writeLog('The paramedics cannot reach the body, so they return to the ambulance and leave. Another crew can be dispatched in twenty minutes.');
  }

  function ambulanceAt(x, y) {
    const state = getState();
    return state.ambulances.find((ambulance) => ambulance.mapKey === state.currentMapKey && ambulance.x === x && ambulance.y === y);
  }

  function moveAmbulanceBackToRoad(ambulance) {
    if (tileAtFor(ambulance.mapKey, ambulance.x, ambulance.y).road) return { ...ambulance, status: 'leaving' };
    const target = closestRoadPoint(ambulance);
    if (!target) return { ...ambulance, status: 'leaving' };
    const step = nextVehicleStepToward({ ...ambulance, target });
    if (!step) return ambulance;
    const moved = { ...ambulance, ...step };
    return tileAtFor(moved.mapKey, moved.x, moved.y).road ? { ...moved, status: 'leaving' } : moved;
  }

  function closestRoadPoint(point) {
    return closestPoint(point, maps[point.mapKey].walkable.filter((tile) => tileAtFor(point.mapKey, tile.x, tile.y).road));
  }

  function nextWaitingCorpse() {
    const state = getState();
    return state.corpses.find((corpse) => !state.ambulances.some((ambulance) => ambulance.corpseId === corpse.id && ambulance.status !== 'leaving')) ?? null;
  }

  function corpseById(corpseId) {
    return getState().corpses.find((corpse) => corpse.id === corpseId) ?? null;
  }

  return { updateAmbulanceResponse, moveAmbulances, updateParamedicCollection, returningAmbulanceFor, ambulanceAt, nextParamedicStep };
}
