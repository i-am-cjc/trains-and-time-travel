const FIRE_ENGINE_CREW_SIZE = 6;
const FIRE_ENGINE_RESPONSE_DISTANCE = 5;
const FIRE_ENGINE_ROAD_Y = 30;

export function isFirefighter(npc) {
  return npc.profile.role === 'firefighter';
}

export function canExtinguishFire(npc) {
  return isFirefighter(npc);
}

export function createFirefighterLogic({
  getState,
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
}) {
  function updateFireResponse() {
    const state = getState();
    if (!state.fires.length) {
      state.lastFireResponseSize = 0;
      recallFirefighters();
      return;
    }

    const activeResponse = state.fireEngines.some((engine) => engine.status !== 'leaving');
    if (!activeResponse || state.fires.length > state.lastFireResponseSize) dispatchFireEngine();
  }

  function dispatchFireEngine() {
    const state = getState();
    const targetFire = state.fires[0];
    if (!targetFire || state.fireEngines.some((engine) => engine.status === 'responding')) return;
    const engine = {
      id: `fire-engine-${state.nextFireEngineId}`,
      mapKey: targetFire.mapKey,
      x: 0,
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
    writeLog('A fire engine siren rises from the left side of the road and races toward the blaze.');
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
      writeLog('The fire engine brakes near the fire and six firefighters leap out with hoses.');
      return { ...moved, status: 'deployed' };
    }
    return moved;
  }

  function deployFirefighters(engine) {
    const state = getState();
    const spawnPoints = uniquePoints([engine, ...neighborsOf(engine), ...neighborsOf({ x: engine.x + 1, y: engine.y })])
      .filter((point) => !tileAtFor(engine.mapKey, point.x, point.y).blocks && !npcAtOnMap(engine.mapKey, point.x, point.y));
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
    const nearestFire = closestFireTo(npc);
    if (!nearestFire) return null;
    const adjacentTargets = neighborsOf(nearestFire).filter((point) => !tileAtFor(npc.mapKey, point.x, point.y).blocks);
    const target = closestPoint(npc, adjacentTargets) ?? nearestFire;
    return nextStepToward({ ...npc, target }, occupied, { avoidFire: false });
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

  return {
    updateFireResponse,
    moveFireEngines,
    returningFireEngineFor,
    fireEngineAt,
    nextFirefighterStep,
  };
}
