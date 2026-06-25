const RECOVERY_WAGON_SPAWN_X = 0;
const RECOVERY_WAGON_ROAD_Y = 30;
const RECOVERY_DISTANCE = 1;

export function createRecoveryWagonLogic({
  getState,
  maps,
  writeLog,
  killPlayer,
  nextVehicleStepToward,
  manhattanDistance,
  tileAtFor,
  closestPoint,
}) {
  function updateRecoveryResponse() {
    const state = getState();
    const wreck = nextWaitingWreck();
    if (!wreck) return;
    if (state.recoveryWagons.some((wagon) => wagon.wreckId === wreck.id && wagon.status !== 'leaving')) return;
    if (state.recoveryWagons.some((wagon) => wagon.status === 'responding')) return;
    dispatchRecoveryWagon(wreck);
  }

  function dispatchRecoveryWagon(wreck) {
    const state = getState();
    state.recoveryWagons.push({
      id: `recovery-wagon-${state.nextRecoveryWagonId}`,
      mapKey: wreck.mapKey,
      x: RECOVERY_WAGON_SPAWN_X,
      y: RECOVERY_WAGON_ROAD_Y,
      dx: 1,
      sprite: 'recoveryWagon',
      status: 'responding',
      wreckId: wreck.id,
      targetWreck: { ...wreck },
    });
    state.nextRecoveryWagonId += 1;
    wreck.status = 'recoveryDispatched';
    writeLog('A recovery wagon rattles in from the left, routing around live traffic toward the burnt-out wreck.');
  }

  function moveRecoveryWagons() {
    const state = getState();
    state.recoveryWagons = state.recoveryWagons
      .map((wagon) => moveRecoveryWagon(wagon))
      .filter((wagon) => wagon.x >= 0 && wagon.x < maps[wagon.mapKey].width);

    if (state.currentMapKey !== 'station') return false;
    const hitWagon = recoveryWagonAt(state.player.x, state.player.y);
    if (!hitWagon) return false;
    killPlayer('A recovery wagon grinds past the traffic queue and knocks you out of the loop.');
    return true;
  }

  function moveRecoveryWagon(wagon) {
    if (wagon.status === 'leaving') return { ...wagon, x: wagon.x + 1 };
    if (wagon.status === 'returning') return moveRecoveryWagonBackToRoad(wagon);

    const wreck = wreckById(wagon.wreckId);
    if (!wreck || wreck.status === 'cleared') return { ...wagon, status: 'returning' };
    const step = nextVehicleStepToward({ ...wagon, target: wreck });
    if (!step) return wagon;
    const moved = { ...wagon, ...step, targetWreck: { ...wreck } };
    if (manhattanDistance(moved, wreck) <= RECOVERY_DISTANCE) {
      clearWreck(wreck);
      writeLog('The recovery wagon winches the burnt vehicle clear, reopening the traffic queue.');
      return { ...moved, status: 'returning' };
    }
    return moved;
  }

  function clearWreck(wreck) {
    const state = getState();
    wreck.status = 'cleared';
    state.wrecks = state.wrecks.filter((candidate) => candidate.id !== wreck.id);
  }

  function recoveryWagonAt(x, y) {
    const state = getState();
    return state.recoveryWagons.find((wagon) => wagon.mapKey === state.currentMapKey && wagon.x === x && wagon.y === y);
  }

  function nextWaitingWreck() {
    return getState().wrecks.find((wreck) => wreck.status === 'waitingRecovery') ?? null;
  }

  function wreckById(wreckId) {
    return getState().wrecks.find((wreck) => wreck.id === wreckId) ?? null;
  }

  function moveRecoveryWagonBackToRoad(wagon) {
    if (tileAtFor(wagon.mapKey, wagon.x, wagon.y).road) return { ...wagon, status: 'leaving' };
    const target = closestRoadPoint(wagon);
    if (!target) return { ...wagon, status: 'leaving' };
    const step = nextVehicleStepToward({ ...wagon, target });
    if (!step) return wagon;
    const moved = { ...wagon, ...step };
    return tileAtFor(moved.mapKey, moved.x, moved.y).road ? { ...moved, status: 'leaving' } : moved;
  }

  function closestRoadPoint(point) {
    return closestPoint(point, maps[point.mapKey].walkable.filter((tile) => tileAtFor(point.mapKey, tile.x, tile.y).road));
  }

  return { updateRecoveryResponse, moveRecoveryWagons, recoveryWagonAt };
}
