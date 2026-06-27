const POLICE_CAR_RESPONSE_DISTANCE = 3;
const POLICE_CAR_SPAWN_X = 72;
const POLICE_CAR_ROAD_Y = 31;
export const DETECTIVE_RESPONSE_DELAY_MINUTES = 5;
const ROAD_TRAFFIC_SCENE_CLEAR_DELAY_MINUTES = 20;
const BLOCKED_REDISPATCH_DELAY_MINUTES = 20;

export function isDetective(npc) {
  return npc.profile.role === 'detective';
}

export function isPoliceResponder(npc) {
  return npc.profile.role === 'detective' || npc.profile.role === 'road traffic officer';
}

export function createDetectiveLogic({
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
}) {
  function updateDetectiveResponse() {
    const crimeScene = nextCrimeSceneNeedingDetective();
    if (!crimeScene) return;
    const state = getState();
    if (state.minutesElapsed < state.nextPoliceCarDispatchMinute) return;
    if (state.policeCars.some((car) => car.sceneId === crimeScene.id && car.status !== 'leaving')) return;
    dispatchPoliceCar(crimeScene);
  }

  function dispatchPoliceCar(scene) {
    const state = getState();
    if (state.policeCars.some((car) => car.status === 'responding')) return;
    const car = {
      id: `police-car-${state.nextPoliceCarId}`,
      mapKey: scene.mapKey,
      x: POLICE_CAR_SPAWN_X,
      y: POLICE_CAR_ROAD_Y,
      dx: 1,
      sprite: 'policeCar',
      status: 'responding',
      sceneId: scene.id,
      targetScene: { ...scene },
    };
    state.nextPoliceCarId += 1;
    state.policeCars.push(car);
    state.nextPoliceCarDispatchMinute = state.minutesElapsed;
    writeLog(scene.roadTrafficBlock
      ? 'A police car answers the road fatality, carrying a traffic officer to close the lane.'
      : 'A police car follows the ambulance call, carrying a detective to the scene.');
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
    const step = nextVehicleStepToward({ ...car, target: scene }, { parkingDistance: POLICE_CAR_RESPONSE_DISTANCE });
    if (!step) return car;
    const moved = { ...car, ...step, targetScene: { ...scene } };
    if (manhattanDistance(moved, scene) <= POLICE_CAR_RESPONSE_DISTANCE) {
      deployPoliceResponder(moved);
      writeLog(scene.roadTrafficBlock
        ? 'The police car stops nearby and a road traffic officer sets out cones and barriers to hold the traffic.'
        : 'The police car stops nearby and a detective steps out, waiting for the ambulance to clear the body.');
      return { ...moved, status: 'deployed' };
    }
    return moved;
  }

  function deployPoliceResponder(car) {
    const state = getState();
    const spawnPoints = uniquePoints([car, ...neighborsOf(car), ...neighborsOf({ x: car.x + 1, y: car.y })])
      .filter((point) => !tileAtFor(car.mapKey, point.x, point.y).blocks && !npcAtOnMap(car.mapKey, point.x, point.y) && !carAtOnMap(car.mapKey, point.x, point.y));
    const point = spawnPoints[0] ?? car;
    const scene = sceneById(car.sceneId);
    const trafficOfficer = scene?.roadTrafficBlock;
    const profile = trafficOfficer ? {
      key: `traffic-officer-${car.id}`,
      name: 'Road Traffic Officer Lane',
      age: 41,
      gender: 'female',
      role: 'road traffic officer',
      goal: 'block the road until twenty minutes after the ambulance removes the person',
      dialogue: ['The traffic officer says, “Road is closed. Cars can wait until the scene is clear.”'],
    } : {
      key: `detective-${car.id}`,
      name: 'Detective Hal Ward',
      age: 46,
      gender: 'male',
      role: 'detective',
      goal: 'secure the scene after the ambulance has collected the body',
      dialogue: ['The detective says, “Nobody crosses the line until I have marked the scene.”'],
    };
    state.npcs.push({ x: point.x, y: point.y, mapKey: car.mapKey, mapSymbol: trafficOfficer ? 'Z' : 'D', profile, route: [point, point], target: { ...car.targetScene }, homePoliceCarId: car.id, assignedSceneId: car.sceneId, pendingDoorActions: [] });
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
      if (scene.roadTrafficBlock) {
        maintainRoadClosure(scene, detective, car);
        return;
      }
      if (scene.status !== 'bodyCollected') {
        detective.target = { x: scene.x, y: scene.y };
        return;
      }
      const workPoint = detectiveWorkPoint(scene, detective);
      if (!workPoint) return;
      detective.target = workPoint;
      if (detective.mapKey === scene.mapKey && detective.x === workPoint.x && detective.y === workPoint.y) {
        finishScene(scene, detective, car);
      }
    });
  }

  function maintainRoadClosure(scene, officer, car) {
    const state = getState();
    if (!state.barriers.some((barrier) => barrier.sceneId === scene.id && barrier.trafficBlock)) {
      state.barriers.push(...trafficBarrierPoints(scene));
    }
    const workPoint = trafficOfficerWorkPoint(scene, officer) ?? { x: scene.x, y: scene.y };
    if (scene.status !== 'bodyCollected') {
      officer.target = workPoint;
      return;
    }
    if (scene.trafficClearMinute === null || scene.trafficClearMinute === undefined) {
      scene.trafficClearMinute = getElapsedMinutes() + ROAD_TRAFFIC_SCENE_CLEAR_DELAY_MINUTES;
      writeLog('The body is removed, but the road traffic officer keeps the closure for twenty more minutes while the scene is made safe.');
    }
    if (getElapsedMinutes() < scene.trafficClearMinute) {
      officer.target = workPoint;
      return;
    }
    state.barriers = state.barriers.filter((barrier) => barrier.sceneId !== scene.id);
    const blockedTrafficHazard = state.hazardPoints.find((hazard) => hazard.sourceId === scene.corpseId && hazard.type === 'blocked-traffic');
    if (blockedTrafficHazard) blockedTrafficHazard.markedClear = true;
    scene.status = 'secured';
    officer.target = { x: car.x, y: car.y };
    removeDetectivesAtPoliceCar(car);
    if (!state.npcs.some((npc) => npc.homePoliceCarId === car.id)) {
      car.status = 'returning';
      writeLog('The road traffic officer clears the barriers and traffic starts moving again.');
    }
  }

  function finishScene(scene, detective, car) {
    const state = getState();
    if (!state.chalkOutlines.some((outline) => outline.sceneId === scene.id)) {
      state.chalkOutlines.push({ sceneId: scene.id, mapKey: scene.mapKey, x: scene.x, y: scene.y });
      state.barriers.push(...barrierPointsAround(scene));
      writeLog('The detective marks a chalk outline and sets barriers around all eight squares surrounding the body.');
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
    if (!isPoliceResponder(npc)) return null;
    const scene = sceneById(npc.assignedSceneId);
    if (scene?.status !== 'secured') return null;
    return state.policeCars.find((car) => car.id === npc.homePoliceCarId && car.status === 'deployed') ?? null;
  }

  function nextDetectiveStep(npc, occupied) {
    const state = getState();
    const car = state.policeCars.find((candidate) => candidate.id === npc.homePoliceCarId);
    const scene = sceneById(npc.assignedSceneId);
    if (scene?.roadTrafficBlock && scene.status !== 'secured') {
      const workPoint = trafficOfficerWorkPoint(scene, npc);
      if (workPoint) return stepOrMarkBlocked(npc, workPoint, occupied);
    }
    if (scene?.status === 'bodyCollected') {
      const workPoint = detectiveWorkPoint(scene, npc, occupied);
      if (workPoint) return stepOrMarkBlocked(npc, workPoint, occupied);
    }
    if (scene?.status === 'secured' && car) {
      return nextStepToward({ ...npc, target: { x: car.x, y: car.y } }, occupied, { avoidFire: false }) ?? null;
    }
    return stepOrMarkBlocked(npc, npc.target, occupied);
  }

  function stepOrMarkBlocked(npc, target, occupied) {
    const step = nextStepToward({ ...npc, target }, occupied, { avoidFire: false }) ?? null;
    if (!step && (npc.x !== target.x || npc.y !== target.y)) markPoliceResponderBlocked(npc);
    return step;
  }

  function markPoliceResponderBlocked(npc) {
    const state = getState();
    const car = state.policeCars.find((candidate) => candidate.id === npc.homePoliceCarId);
    if (!car || car.status !== 'deployed' || car.blockedReturn) return;
    car.blockedReturn = true;
    car.status = 'returning';
    state.nextPoliceCarDispatchMinute = getElapsedMinutes() + BLOCKED_REDISPATCH_DELAY_MINUTES;
    state.barriers = state.barriers.filter((barrier) => barrier.sceneId !== npc.assignedSceneId);
    state.npcs = state.npcs.filter((candidate) => candidate.homePoliceCarId !== car.id);
    writeLog('The police responder cannot reach the scene, so they return to the car and leave. Another crew can be dispatched in twenty minutes.');
  }

  function policeCarAt(x, y) {
    const state = getState();
    return state.policeCars.find((car) => car.mapKey === state.currentMapKey && car.x === x && car.y === y);
  }

  function barrierPointsAround(scene) {
    return pointsAround(scene, 1).map((point) => ({ sceneId: scene.id, mapKey: scene.mapKey, x: point.x, y: point.y }));
  }

  function trafficBarrierPoints(scene) {
    const roadPoints = [scene, ...neighborsOf(scene)]
      .filter((point) => tileAtFor(scene.mapKey, point.x, point.y).road);
    const points = roadPoints.length ? roadPoints : [scene];
    return points.map((point) => ({ sceneId: scene.id, mapKey: scene.mapKey, x: point.x, y: point.y, trafficBlock: true }));
  }

  function trafficOfficerWorkPoint(scene, officer) {
    return closestPoint(officer, neighborsOf(scene).filter((point) => !tileAtFor(scene.mapKey, point.x, point.y).blocks)) ?? scene;
  }

  function detectiveWorkPoint(scene, detective, occupied = new Set()) {
    const blocked = new Set(barrierPointsAround(scene).map((point) => positionKey(point.x, point.y)));
    const candidates = pointsAround(scene, 2)
      .filter((point) => !blocked.has(positionKey(point.x, point.y)))
      .filter((point) => !tileAtFor(scene.mapKey, point.x, point.y).blocks)
      .filter((point) => !npcAtOnMap(scene.mapKey, point.x, point.y) || (point.x === detective.x && point.y === detective.y))
      .sort((a, b) => manhattanDistance(detective, a) - manhattanDistance(detective, b));
    return candidates.find((point) => (
      (point.x === detective.x && point.y === detective.y)
      || nextStepToward({ ...detective, target: point }, occupied, { avoidFire: false })
    )) ?? closestPoint(detective, candidates);
  }

  function pointsAround(point, radius) {
    const points = [];
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        points.push({ x: point.x + dx, y: point.y + dy });
      }
    }
    return points;
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
    return state.crimeScenes.find((scene) => {
      if (scene.status === 'secured') return false;
      const readyToDispatch = scene.roadTrafficBlock
        || (scene.detectiveDispatchMinute !== null && getElapsedMinutes() >= scene.detectiveDispatchMinute);
      return readyToDispatch
        && !state.policeCars.some((car) => car.sceneId === scene.id && car.status !== 'leaving');
    }) ?? null;
  }

  function sceneById(sceneId) {
    return getState().crimeScenes.find((scene) => scene.id === sceneId) ?? null;
  }

  return { updateDetectiveResponse, movePoliceCars, updateDetectiveSceneWork, returningPoliceCarFor, policeCarAt, nextDetectiveStep };
}
