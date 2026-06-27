const FIRE_ENGINE_CREW_SIZE = 4;
const FIRE_ENGINE_RESPONSE_DISTANCE = 5;
const FIRE_ENGINE_SPAWN_X = 72;
const FIRE_ENGINE_ROAD_Y = 30;
const BLOCKED_REDISPATCH_DELAY_MINUTES = 20;

export function isFirefighter(npc) {
  return npc.profile.role === 'firefighter';
}

export function canExtinguishFire(npc) {
  return isFirefighter(npc);
}

export function createFirefighterLogic({
  getState,
  getElapsedMinutes,
  maps,
  writeLog,
  killPlayer,
  closestFireTo,
  nextVehicleStepToward,
  nextStepToward,
  manhattanDistance,
  tileAtFor,
  npcAtOnMap,
  uniquePoints,
  neighborsOf,
  closestPoint,
  carAtOnMap,
}) {
  function updateFireResponse() {
    const state = getState();
    if (!state.fires.length) {
      state.lastFireResponseSize = 0;
      recallFirefighters();
      return;
    }

    const activeResponse = state.fireEngines.some((engine) => engine.status !== 'leaving');
    if (state.minutesElapsed < state.nextFireEngineDispatchMinute) return;
    if (!activeResponse || state.fires.length > state.lastFireResponseSize) dispatchFireEngine();
  }

  function dispatchFireEngine() {
    const state = getState();
    const targetFire = state.fires[0];
    if (!targetFire || state.fireEngines.some((engine) => engine.status === 'responding')) return;
    const engine = {
      id: `fire-engine-${state.nextFireEngineId}`,
      mapKey: targetFire.mapKey,
      x: FIRE_ENGINE_SPAWN_X,
      y: FIRE_ENGINE_ROAD_Y,
      dx: 1,
      sprite: 'fireEngine',
      status: 'responding',
      targetFire: { ...targetFire },
    };
    state.nextFireEngineId += 1;
    state.fireEngines.push(engine);
    state.fireEngineDispatchedThisTurn = true;
    state.lastFireResponseSize = state.fires.length;
    state.nextFireEngineDispatchMinute = state.minutesElapsed;
    writeLog('A fire engine siren rises from the station road and races toward the blaze.');
  }

  function moveFireEngines() {
    const state = getState();
    state.fireEngines = state.fireEngines
      .map((engine) => moveFireEngine(engine))
      .filter((engine) => engine.x >= 0 && engine.x < maps[engine.mapKey].width);

    if (state.currentMapKey !== 'station') return false;
    const hitEngine = fireEngineAt(state.player.x, state.player.y);
    if (!hitEngine) return false;
    killPlayer('A fire engine roars through the road and knocks you out of the loop.');
    return true;
  }

  function moveFireEngine(engine) {
    if (engine.status === 'leaving') return { ...engine, x: engine.x + 1 };
    if (engine.status === 'returning') return moveFireEngineBackToRoad(engine);
    if (engine.status === 'deployed') return engine;

    const nearestFire = closestFireTo({ mapKey: engine.mapKey, x: engine.x, y: engine.y });
    if (!nearestFire) return { ...engine, status: 'returning' };
    const step = nextVehicleStepToward({ ...engine, target: nearestFire });
    if (!step) return engine;
    const moved = { ...engine, ...step, targetFire: { ...nearestFire } };
    if (manhattanDistance(moved, nearestFire) <= FIRE_ENGINE_RESPONSE_DISTANCE) {
      deployFirefighters(moved);
      writeLog(`The fire engine brakes near the fire and ${FIRE_ENGINE_CREW_SIZE} firefighters leap out with hoses.`);
      return { ...moved, status: 'deployed' };
    }
    return moved;
  }

  function deployFirefighters(engine) {
    const state = getState();
    const spawnPoints = uniquePoints([engine, ...neighborsOf(engine), ...neighborsOf({ x: engine.x + 1, y: engine.y })])
      .filter((point) => !tileAtFor(engine.mapKey, point.x, point.y).blocks && !npcAtOnMap(engine.mapKey, point.x, point.y) && !carAtOnMap(engine.mapKey, point.x, point.y));
    for (let index = 0; index < FIRE_ENGINE_CREW_SIZE; index += 1) {
      const point = spawnPoints[index % spawnPoints.length] ?? engine;
      state.npcs.push(createFirefighterState(engine, point, index));
    }
  }

  function createFirefighterState(engine, point, index) {
    const profile = {
      key: `firefighter-${engine.id}-${index}`,
      name: `Firefighter ${index + 1}`,
      age: 30 + index,
      gender: index % 2 ? 'male' : 'female',
      role: 'firefighter',
      goal: 'put out fires and return to the engine when the blaze is gone',
      dialogue: ['The firefighter says, “Stand back. We have the fire.”'],
    };
    return { x: point.x, y: point.y, mapKey: engine.mapKey, mapSymbol: 'F', profile, route: [point, point], target: { ...point }, homeEngineId: engine.id, pendingDoorActions: [] };
  }

  function recallFirefighters() {
    const state = getState();
    state.fireEngines.forEach((engine) => {
      if (engine.status !== 'deployed') return;
      const crew = state.npcs.filter((npc) => npc.homeEngineId === engine.id);
      crew.forEach((npc) => { npc.target = { x: engine.x, y: engine.y }; });
      removeFirefightersAtEngine(engine);
      if (!state.npcs.some((npc) => npc.homeEngineId === engine.id)) {
        engine.status = 'returning';
        writeLog('With the fire out, the firefighters climb back aboard and the engine returns to the road.');
      }
    });
  }

  function removeFirefightersAtEngine(engine) {
    const state = getState();
    state.npcs = state.npcs.filter((npc) => (
      npc.homeEngineId !== engine.id
      || npc.mapKey !== engine.mapKey
      || npc.x !== engine.x
      || npc.y !== engine.y
    ));
  }

  function returningFireEngineFor(npc) {
    const state = getState();
    if (!isFirefighter(npc) || state.fires.some((fire) => fire.mapKey === npc.mapKey)) return null;
    return state.fireEngines.find((engine) => engine.id === npc.homeEngineId && engine.status === 'deployed') ?? null;
  }

  function fireEngineAt(x, y) {
    const state = getState();
    return state.fireEngines.find((engine) => engine.mapKey === state.currentMapKey && engine.x === x && engine.y === y);
  }

  function nextFirefighterStep(npc, occupied) {
    if (npc.fallbackDespawnAt) return nextStepToward(npc, occupied, { avoidFire: false, avoidRoad: true });

    const returningEngine = returningFireEngineFor(npc);
    if (returningEngine) {
      const target = { x: returningEngine.x, y: returningEngine.y };
      const step = nextStepToward({ ...npc, target }, occupied, { avoidFire: false, avoidRoad: true });
      if (!step && (npc.x !== target.x || npc.y !== target.y)) return sendFirefighterToFireStation(npc, occupied);
      return step;
    }

    const nearestFire = closestFireTo(npc);
    if (!nearestFire) return null;
    const adjacentTargets = neighborsOf(nearestFire).filter((point) => !tileAtFor(npc.mapKey, point.x, point.y).blocks);
    const target = closestPoint(npc, adjacentTargets) ?? nearestFire;
    const step = nextStepToward({ ...npc, target }, occupied, { avoidFire: false });
    if (!step && (npc.x !== target.x || npc.y !== target.y)) markFireCrewBlocked(npc);
    return step;
  }

  function sendFirefighterToFireStation(npc, occupied) {
    const fallback = closestFireStationDespawnPoint(npc);
    if (!fallback) return null;
    npc.target = fallback;
    npc.fallbackDespawnAt = fallback;
    npc.profile.goal = 'walk back to the fire station without stepping into the road';
    writeLog(`${npc.profile.name} cannot safely get back to the engine, so they walk back to the fire station instead.`);
    return nextStepToward(npc, occupied, { avoidFire: false, avoidRoad: true });
  }

  function markFireCrewBlocked(npc) {
    const state = getState();
    const engine = state.fireEngines.find((candidate) => candidate.id === npc.homeEngineId);
    if (!engine || engine.status !== 'deployed' || engine.blockedReturn) return;
    engine.blockedReturn = true;
    engine.status = 'returning';
    state.nextFireEngineDispatchMinute = getElapsedMinutes() + BLOCKED_REDISPATCH_DELAY_MINUTES;
    state.npcs = state.npcs.filter((candidate) => candidate.homeEngineId !== engine.id);
    writeLog('The firefighters cannot reach the blaze, so they climb back into the engine and leave. Another crew can be dispatched in twenty minutes.');
  }

  function moveFireEngineBackToRoad(engine) {
    if (tileAtFor(engine.mapKey, engine.x, engine.y).road) return { ...engine, status: 'leaving' };
    const target = closestRoadPoint(engine);
    if (!target) return { ...engine, status: 'leaving' };
    const step = nextVehicleStepToward({ ...engine, target });
    if (!step) return engine;
    const moved = { ...engine, ...step };
    return tileAtFor(moved.mapKey, moved.x, moved.y).road ? { ...moved, status: 'leaving' } : moved;
  }

  function closestRoadPoint(point) {
    return closestPoint(point, maps[point.mapKey].walkable.filter((tile) => tileAtFor(point.mapKey, tile.x, tile.y).road));
  }

  function closestFireStationDespawnPoint(point) {
    const candidates = maps[point.mapKey].walkable.filter((tile) => (
      !tileAtFor(point.mapKey, tile.x, tile.y).road
      && neighborsOf(tile).some((neighbor) => tileAtFor(point.mapKey, neighbor.x, neighbor.y).description === 'Fire station equipment bay.')
    ));
    return closestPoint(point, candidates);
  }

  return {
    updateFireResponse,
    moveFireEngines,
    returningFireEngineFor,
    fireEngineAt,
    nextFirefighterStep,
  };
}
