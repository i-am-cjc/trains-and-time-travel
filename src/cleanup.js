const CLEANUP_CREW_SIZE = 4;
const CLEANUP_VAN_RESPONSE_DISTANCE = 4;
const CLEANUP_VAN_ROAD_Y = 29;
const CLEANING_TURNS_REQUIRED = 3;

export function isCleanupResponder(npc) {
  return npc.profile.role === 'cleanup responder';
}

export function createCleanupLogic({
  getState,
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
}) {
  function updateCleanupResponse() {
    const hazard = nextWaitingHazard();
    if (!hazard) return;
    const state = getState();
    if (state.cleanupVans.some((van) => van.hazardId === hazard.id && van.status !== 'leaving')) return;
    dispatchCleanupVan(hazard);
  }

  function dispatchCleanupVan(hazard) {
    const state = getState();
    if (state.cleanupVans.some((van) => van.status === 'responding')) return;
    const van = {
      id: `cleanup-van-${state.nextCleanupVanId}`,
      mapKey: hazard.mapKey,
      x: 0,
      y: CLEANUP_VAN_ROAD_Y,
      dx: 1,
      sprite: 'cleanupVan',
      status: 'responding',
      hazardId: hazard.id,
      targetHazard: { ...hazard },
    };
    state.nextCleanupVanId += 1;
    state.cleanupVans.push(van);
    hazard.status = 'cleanupDispatched';
    writeLog(`A cleanup van rolls in after the responders, carrying four hazmat-suited cleaners toward ${hazardLabel(hazard)}.`);
  }

  function moveCleanupVans() {
    const state = getState();
    state.cleanupVans = state.cleanupVans
      .map((van) => moveCleanupVan(van))
      .filter((van) => van.x >= 0 && van.x < maps[van.mapKey].width);

    if (state.currentMapKey !== 'station') return false;
    const hitVan = cleanupVanAt(state.player.x, state.player.y);
    if (!hitVan) return false;
    killPlayer('A cleanup van clips you while chasing the mess left behind.');
    return true;
  }

  function moveCleanupVan(van) {
    if (van.status === 'leaving') return { ...van, x: van.x + 1 };
    if (van.status === 'returning') return moveCleanupVanBackToRoad(van);
    if (van.status === 'deployed') return van;

    const hazard = hazardById(van.hazardId);
    if (!hazard || hazard.status === 'cleaned') return { ...van, status: 'returning' };
    const step = nextVehicleStepToward({ ...van, target: hazard });
    if (!step) return van;
    const moved = { ...van, ...step, targetHazard: { ...hazard } };
    if (manhattanDistance(moved, hazard) <= CLEANUP_VAN_RESPONSE_DISTANCE) {
      deployCleanupCrew(moved);
      writeLog('The cleanup van parks nearby and four hazmat-suited cleaners step out with sealed bins and a cleanup sign.');
      return { ...moved, status: 'deployed' };
    }
    return moved;
  }

  function deployCleanupCrew(van) {
    const state = getState();
    const spawnPoints = uniquePoints([van, ...neighborsOf(van), ...neighborsOf({ x: van.x + 1, y: van.y })])
      .filter((point) => !tileAtFor(van.mapKey, point.x, point.y).blocks && !npcAtOnMap(van.mapKey, point.x, point.y));
    for (let index = 0; index < CLEANUP_CREW_SIZE; index += 1) {
      const point = spawnPoints[index % spawnPoints.length] ?? van;
      state.npcs.push(createCleanupResponderState(van, point, index));
    }
  }

  function createCleanupResponderState(van, point, index) {
    const hazard = van.targetHazard;
    const profile = {
      key: `cleanup-responder-${van.id}-${index}`,
      name: `Cleanup Crew ${index + 1}`,
      age: 29 + index,
      gender: index % 2 ? 'male' : 'female',
      role: 'cleanup responder',
      goal: 'post a cleanup-in-progress sign, clean hazards, and return to the cleanup van',
      dialogue: cleanupDialogue(hazard),
      description: `A cleanup responder in a pale hazmat suit assigned to ${hazardLabel(hazard)}.`,
    };
    return { x: point.x, y: point.y, mapKey: van.mapKey, mapSymbol: 'C', profile, route: [point, point], target: { x: hazard.x, y: hazard.y }, homeCleanupVanId: van.id, assignedHazardId: van.hazardId, pendingDoorActions: [] };
  }

  function updateCleanupWork() {
    const state = getState();
    state.cleanupVans.forEach((van) => {
      if (van.status !== 'deployed') return;
      const hazard = hazardById(van.hazardId);
      const crew = state.npcs.filter((npc) => npc.homeCleanupVanId === van.id);
      if (!hazard || hazard.status === 'cleaned') {
        crew.forEach((npc) => { npc.target = { x: van.x, y: van.y }; });
        removeCleanupCrewAtVan(van);
        if (!state.npcs.some((npc) => npc.homeCleanupVanId === van.id)) {
          van.status = 'returning';
          writeLog('The cleanup crew packs up the cleanup sign and the van returns to the road.');
        }
        return;
      }

      const workPoint = cleanupWorkPoint(hazard, crew[0] ?? van);
      crew.forEach((npc) => { npc.target = workPoint ?? { x: hazard.x, y: hazard.y }; });
      placeCleanupSign(hazard);
      const adjacentCrew = crew.filter((npc) => npc.mapKey === hazard.mapKey && manhattanDistance(npc, hazard) <= 1);
      if (!adjacentCrew.length) return;
      hazard.cleaningTurns = (hazard.cleaningTurns ?? 0) + adjacentCrew.length;
      if (hazard.cleaningTurns < CLEANING_TURNS_REQUIRED) return;
      cleanHazard(hazard);
      writeLog(cleanupFinishedMessage(hazard));
    });
  }

  function placeCleanupSign(hazard) {
    const state = getState();
    if (state.cleanupSigns.some((sign) => sign.hazardId === hazard.id)) return;
    const point = cleanupWorkPoint(hazard, hazard) ?? hazard;
    state.cleanupSigns.push({ hazardId: hazard.id, mapKey: hazard.mapKey, ...point });
  }


  function cleanHazard(hazard) {
    const state = getState();
    hazard.status = 'cleaned';
    state.cleanupSigns = state.cleanupSigns.filter((sign) => sign.hazardId !== hazard.id);
    if (hazard.type === 'ash') {
      cleanAllAshPiles(hazard.mapKey);
    } else {
      state.ashPiles = state.ashPiles.filter((ash) => ash.id !== hazard.sourceId);
    }
    state.bloodPatches = state.bloodPatches.filter((blood) => blood.id !== hazard.sourceId);
    if (hazard.type === 'corpse') {
      const scene = state.crimeScenes.find((candidate) => candidate.corpseId === hazard.sourceId);
      if (scene) {
        state.barriers = state.barriers.filter((barrier) => barrier.sceneId !== scene.id);
        state.chalkOutlines = state.chalkOutlines.filter((outline) => outline.sceneId !== scene.id);
      }
    }
    if (hazard.type === 'blocked-traffic') hazard.markedClear = true;
  }

  function removeCleanupCrewAtVan(van) {
    const state = getState();
    state.npcs = state.npcs.filter((npc) => (
      npc.homeCleanupVanId !== van.id
      || npc.mapKey !== van.mapKey
      || npc.x !== van.x
      || npc.y !== van.y
    ));
  }

  function returningCleanupVanFor(npc) {
    const state = getState();
    if (!isCleanupResponder(npc)) return null;
    const hazard = hazardById(npc.assignedHazardId);
    if (hazard?.status !== 'cleaned') return null;
    return state.cleanupVans.find((van) => van.id === npc.homeCleanupVanId && van.status === 'deployed') ?? null;
  }

  function nextCleanupStep(npc, occupied) {
    return nextStepToward(npc, occupied, { avoidFire: false }) ?? null;
  }

  function cleanupVanAt(x, y) {
    const state = getState();
    return state.cleanupVans.find((van) => van.mapKey === state.currentMapKey && van.x === x && van.y === y);
  }

  function nextWaitingHazard() {
    const state = getState();
    return state.hazardPoints.find((hazard) => hazard.type === 'ash' && hazard.status === 'waitingCleanup' && respondersFinished(hazard))
      ?? state.hazardPoints.find((hazard) => hazard.status === 'waitingCleanup' && respondersFinished(hazard))
      ?? null;
  }

  function respondersFinished(hazard) {
    const state = getState();
    const fireDone = !state.fires.some((fire) => fire.mapKey === hazard.mapKey)
      && !state.fireEngines.some((engine) => engine.mapKey === hazard.mapKey && engine.status !== 'leaving');
    const ambulanceDone = !state.ambulances.some((ambulance) => ambulance.mapKey === hazard.mapKey && ambulance.status !== 'leaving');
    const policeDone = !state.policeCars.some((car) => car.mapKey === hazard.mapKey && car.status !== 'leaving');
    return fireDone && ambulanceDone && policeDone;
  }

  function hazardById(hazardId) {
    return getState().hazardPoints.find((hazard) => hazard.id === hazardId) ?? null;
  }

  function cleanupWorkPoint(hazard, cleaner) {
    return closestPoint(cleaner, neighborsOf(hazard).filter((point) => !tileAtFor(hazard.mapKey, point.x, point.y).blocks)) ?? hazard;
  }

  function cleanAllAshPiles(mapKey) {
    const state = getState();
    const ashIds = new Set(state.ashPiles.filter((ash) => ash.mapKey === mapKey).map((ash) => ash.id));
    state.ashPiles = state.ashPiles.filter((ash) => ash.mapKey !== mapKey);
    state.hazardPoints.forEach((candidate) => {
      if (candidate.type === 'ash' && ashIds.has(candidate.sourceId)) candidate.status = 'cleaned';
    });
    state.cleanupSigns = state.cleanupSigns.filter((sign) => {
      const signHazard = state.hazardPoints.find((candidate) => candidate.id === sign.hazardId);
      return signHazard?.type !== 'ash' || signHazard.mapKey !== mapKey;
    });
  }

  function cleanupFinishedMessage(hazard) {
    if (hazard.type === 'ash') return 'The hazmat crew posts one cleanup sign, sweeps every ash pile from the area, then carries the sign away.';
    return `The hazmat crew seals and scrubs ${hazardLabel(hazard)}, then carries the cleanup sign away.`;
  }

  function moveCleanupVanBackToRoad(van) {
    if (tileAtFor(van.mapKey, van.x, van.y).road) return { ...van, status: 'leaving' };
    const target = closestRoadPoint(van);
    if (!target) return { ...van, status: 'leaving' };
    const step = nextVehicleStepToward({ ...van, target });
    if (!step) return van;
    const moved = { ...van, ...step };
    return tileAtFor(moved.mapKey, moved.x, moved.y).road ? { ...moved, status: 'leaving' } : moved;
  }

  function closestRoadPoint(point) {
    return closestPoint(point, maps[point.mapKey].walkable.filter((tile) => tileAtFor(point.mapKey, tile.x, tile.y).road));
  }

  return { updateCleanupResponse, moveCleanupVans, updateCleanupWork, returningCleanupVanFor, cleanupVanAt, nextCleanupStep };
}

function cleanupDialogue(hazard) {
  const repeated = hazard.playerIncidentCount > 1;
  const repeatLine = repeated ? 'The cleaner says, “Same coordinates, same traveler-shaped problem. We are adding this to your file.”' : null;
  const byType = {
    ash: 'The cleaner says, “Ash gets everywhere. One sign, one sweep, then the area is clear.”',
    blood: 'The cleaner says, “Biohazard protocol. Do not step in the evidence, or what used to be evidence.”',
    corpse: 'The cleaner says, “Body is gone, but the tile remembers. We make it forget safely.”',
    'blocked-traffic': 'The cleaner says, “High-traffic obstruction. We post one sign, clear it, and move on.”',
  };
  return [repeatLine, byType[hazard.type] ?? 'The cleaner says, “Contain, clean, confirm, leave.”'].filter(Boolean);
}

function hazardLabel(hazard) {
  return {
    ash: 'an ash pile',
    blood: 'a blood-spattered tile',
    corpse: 'corpse aftermath',
    'blocked-traffic': 'a blocked high-traffic tile',
  }[hazard.type] ?? 'a hazard';
}
