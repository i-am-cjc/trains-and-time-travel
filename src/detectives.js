const POLICE_CAR_RESPONSE_DISTANCE = 3;
const POLICE_CAR_ROAD_Y = 31;

export function isDetective(npc) {
  return npc.profile.role === 'detective';
}

export function createDetectiveLogic({
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
}) {
  function updateDetectiveResponse() {
    const crimeScene = nextCrimeSceneNeedingDetective();
    if (!crimeScene) return;
    const state = getState();
    if (state.policeCars.some((car) => car.sceneId === crimeScene.id && car.status !== 'leaving')) return;
    dispatchPoliceCar(crimeScene);
  }

  function dispatchPoliceCar(scene) {
    const state = getState();
    if (state.policeCars.some((car) => car.status === 'responding')) return;
    const car = {
      id: `police-car-${state.nextPoliceCarId}`,
      mapKey: scene.mapKey,
      x: 0,
      y: POLICE_CAR_ROAD_Y,
      dx: 1,
      sprite: 'policeCar',
      status: 'responding',
      sceneId: scene.id,
      targetScene: { ...scene },
    };
    state.nextPoliceCarId += 1;
    state.policeCars.push(car);
    writeLog('A police car follows the ambulance call, carrying a detective to the scene.');
  }

  function movePoliceCars() {
    const state = getState();
    state.policeCars = state.policeCars
      .map((car) => movePoliceCar(car))
      .filter((car) => car.x >= 0 && car.x < maps[car.mapKey].width);

    if (state.currentMapKey !== 'station') return false;
    const hitCar = policeCarAt(state.player.x, state.player.y);
    if (!hitCar) return false;
    killPlayer('A police car speeds into the scene and knocks the loop loose.');
    return true;
  }

  function movePoliceCar(car) {
    if (car.status === 'leaving') return { ...car, x: car.x + 1 };
    if (car.status === 'returning') return movePoliceCarBackToRoad(car);
    if (car.status === 'deployed') return car;

    const scene = sceneById(car.sceneId);
    if (!scene) return { ...car, status: 'returning' };
    const step = nextVehicleStepToward({ ...car, target: scene });
    if (!step) return car;
    const moved = { ...car, ...step, targetScene: { ...scene } };
    if (manhattanDistance(moved, scene) <= POLICE_CAR_RESPONSE_DISTANCE) {
      deployDetective(moved);
      writeLog('The police car stops nearby and a detective steps out, waiting for the ambulance to clear the body.');
      return { ...moved, status: 'deployed' };
    }
    return moved;
  }

  function deployDetective(car) {
    const state = getState();
    const spawnPoints = uniquePoints([car, ...neighborsOf(car), ...neighborsOf({ x: car.x + 1, y: car.y })])
      .filter((point) => !tileAtFor(car.mapKey, point.x, point.y).blocks && !npcAtOnMap(car.mapKey, point.x, point.y));
    const point = spawnPoints[0] ?? car;
    const profile = {
      key: `detective-${car.id}`,
      name: 'Detective Hal Ward',
      age: 46,
      gender: 'male',
      role: 'detective',
      goal: 'secure the scene after the ambulance has collected the body',
      dialogue: ['The detective says, “Nobody crosses the line until I have marked the scene.”'],
    };
    state.npcs.push({ x: point.x, y: point.y, mapKey: car.mapKey, mapSymbol: 'D', profile, route: [point, point], target: { ...car.targetScene }, homePoliceCarId: car.id, assignedSceneId: car.sceneId, pendingDoorActions: [] });
  }

  function updateDetectiveSceneWork() {
    const state = getState();
    state.policeCars.forEach((car) => {
      if (car.status !== 'deployed') return;
      const scene = sceneById(car.sceneId);
      const detective = state.npcs.find((npc) => npc.homePoliceCarId === car.id);
      if (!scene) return;
      if (!detective) {
        if (scene.status === 'secured') car.status = 'returning';
        return;
      }
      if (scene.status !== 'bodyCollected') {
        detective.target = { x: scene.x, y: scene.y };
        return;
      }
      detective.target = { x: scene.x, y: scene.y };
      if (detective.mapKey === scene.mapKey && manhattanDistance(detective, scene) <= 1) {
        finishScene(scene, detective, car);
      }
    });
  }

  function finishScene(scene, detective, car) {
    const state = getState();
    if (!state.chalkOutlines.some((outline) => outline.sceneId === scene.id)) {
      state.chalkOutlines.push({ sceneId: scene.id, mapKey: scene.mapKey, x: scene.x, y: scene.y });
      state.barriers.push(...barrierPointsAround(scene));
      writeLog('The detective marks a chalk outline and sets a barrier around the square where the body lay.');
    }
    scene.status = 'secured';
    detective.target = { x: car.x, y: car.y };
    removeDetectivesAtPoliceCar(car);
    if (!state.npcs.some((npc) => npc.homePoliceCarId === car.id)) {
      car.status = 'returning';
      writeLog('The detective returns to the police car and leaves the taped-off scene behind.');
    }
  }

  function removeDetectivesAtPoliceCar(car) {
    const state = getState();
    state.npcs = state.npcs.filter((npc) => (
      npc.homePoliceCarId !== car.id
      || npc.mapKey !== car.mapKey
      || npc.x !== car.x
      || npc.y !== car.y
    ));
  }

  function returningPoliceCarFor(npc) {
    const state = getState();
    if (!isDetective(npc)) return null;
    const scene = sceneById(npc.assignedSceneId);
    if (scene?.status !== 'secured') return null;
    return state.policeCars.find((car) => car.id === npc.homePoliceCarId && car.status === 'deployed') ?? null;
  }

  function nextDetectiveStep(npc, occupied) {
    return nextStepToward(npc, occupied, { avoidFire: false }) ?? null;
  }

  function policeCarAt(x, y) {
    const state = getState();
    return state.policeCars.find((car) => car.mapKey === state.currentMapKey && car.x === x && car.y === y);
  }

  function barrierPointsAround(scene) {
    return neighborsOf(scene).map((point) => ({ sceneId: scene.id, mapKey: scene.mapKey, x: point.x, y: point.y }));
  }

  function movePoliceCarBackToRoad(car) {
    if (tileAtFor(car.mapKey, car.x, car.y).road) return { ...car, status: 'leaving' };
    const target = closestRoadPoint(car);
    if (!target) return { ...car, status: 'leaving' };
    const step = nextVehicleStepToward({ ...car, target });
    if (!step) return car;
    const moved = { ...car, ...step };
    return tileAtFor(moved.mapKey, moved.x, moved.y).road ? { ...moved, status: 'leaving' } : moved;
  }

  function closestRoadPoint(point) {
    return closestPoint(point, maps[point.mapKey].walkable.filter((tile) => tileAtFor(point.mapKey, tile.x, tile.y).road));
  }

  function nextCrimeSceneNeedingDetective() {
    const state = getState();
    return state.crimeScenes.find((scene) => scene.status !== 'secured' && !state.policeCars.some((car) => car.sceneId === scene.id && car.status !== 'leaving')) ?? null;
  }

  function sceneById(sceneId) {
    return getState().crimeScenes.find((scene) => scene.id === sceneId) ?? null;
  }

  return { updateDetectiveResponse, movePoliceCars, updateDetectiveSceneWork, returningPoliceCarFor, policeCarAt, nextDetectiveStep };
}
