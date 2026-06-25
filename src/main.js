import { Application, Container, Graphics } from 'pixi.js';
import { directions, LOOP_MINUTES, MAP_URLS, MAX_LOG_ENTRIES, RESET_EFFECT_MS, SIGHT_RADIUS, TILE_SIZE } from './constants.js';
import { createScheduledEvents } from './events.js';
import { createItemDefinitions, placedItems } from './items.js';
import { npcBlockedRemarks, npcDefinitions, npcMapSymbols } from './npcs.js';
import { createFirefighterLogic, canExtinguishFire, isFirefighter } from './firefighters.js';
import { createAmbulanceLogic, isParamedic } from './ambulances.js';
import { createDetectiveLogic, isDetective } from './detectives.js';
import { terrain } from './terrain.js';
import './styles.css';

const app = new Application();
const world = new Container();
const hud = document.querySelector('#hud');
const log = document.querySelector('#log');
const inventoryList = document.querySelector('#inventory-list');
const inspectButton = document.querySelector('#inspect-button');
const inspectStatus = document.querySelector('#inspect-status');
const loopEffect = document.querySelector('#loop-effect');
const readableOverlay = document.querySelector('#readable-overlay');
const readableTitle = document.querySelector('#readable-title');
const readableText = document.querySelector('#readable-text');
let inspectMode = false;
let state;
let loopCount = 0;
let resetEffectTimeout;
const CAR_SPAWN_MINUTES = 5;
const CAR_SPAWN_MAX_MINUTES = 15;
const NPC_ROAD_PATH_COST = 20;

const itemDefinitions = createItemDefinitions({ addLoopMinutes, fireGun, igniteFire, writeLog, draw });
const scheduledEvents = createScheduledEvents({ updateTerrain, moveItem, writeLog, queueStationMasterDoorAction });
let updateFireResponse;
let moveFireEngines;
let returningFireEngineFor;
let fireEngineAt;
let nextFirefighterStep;
let updateAmbulanceResponse;
let moveAmbulances;
let updateParamedicCollection;
let returningAmbulanceFor;
let ambulanceAt;
let nextParamedicStep;
let updateDetectiveResponse;
let movePoliceCars;
let updateDetectiveSceneWork;
let returningPoliceCarFor;
let policeCarAt;
let nextDetectiveStep;

await app.init({ background: '#000000', resizeTo: document.querySelector('#game'), antialias: false });
document.querySelector('#game').appendChild(app.canvas);
app.stage.addChild(world);

const maps = Object.fromEntries(await Promise.all(
  Object.entries(MAP_URLS).map(async ([key, url]) => [key, await loadMap(url, key)]),
));
({ updateFireResponse, moveFireEngines, returningFireEngineFor, fireEngineAt, nextFirefighterStep } = createFirefighterLogic({
  getState: () => state,
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
}));

({ updateAmbulanceResponse, moveAmbulances, updateParamedicCollection, returningAmbulanceFor, ambulanceAt, nextParamedicStep } = createAmbulanceLogic({
  getState: () => state,
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
  onCorpseCollected: markCorpseCollected,
}));
({ updateDetectiveResponse, movePoliceCars, updateDetectiveSceneWork, returningPoliceCarFor, policeCarAt, nextDetectiveStep } = createDetectiveLogic({
  getState: () => state,
  getElapsedMinutes: elapsedMinutes,
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
}));
let map = maps.station;
resetLoop('The doors hiss open. You step onto the platform with two hours before everything resets.', { effect: false });

window.addEventListener('keydown', (event) => {
  if (inspectMode) return;
  if (event.code === 'Space') {
    event.preventDefault();
    spendMinute();
    return;
  }
  if (event.code === 'KeyE') {
    event.preventDefault();
    interact();
    return;
  }
  if (!directions[event.code]) return;
  event.preventDefault();
  if (state.shootingMode) {
    fireGun(...directions[event.code]);
    return;
  }
  tryMove(...directions[event.code]);
});

inspectButton.addEventListener('click', () => {
  inspectMode = !inspectMode;
  inspectButton.classList.toggle('active', inspectMode);
  inspectStatus.textContent = inspectMode ? 'Click any visible or remembered square for a description.' : 'Use arrow keys or WASD to move, E to interact, Space to wait.';
});

app.canvas.addEventListener('click', (event) => {
  if (!inspectMode) return;
  const rect = app.canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left - world.x) / TILE_SIZE);
  const y = Math.floor((event.clientY - rect.top - world.y) / TILE_SIZE);
  describeTile(x, y);
});

function resetLoop(message, { effect = true } = {}) {
  loopCount += 1;
  map = maps.station;
  state = {
    player: { ...map.start },
    minutesLeft: LOOP_MINUTES,
    loopLimit: LOOP_MINUTES,
    inventory: [],
    items: placedItems.map((item) => ({ ...item })),
    terrainOverrides: {},
    tileOverrides: {},
    currentMapKey: 'station',
    triggeredEventIds: new Set(),
    facing: [0, 1],
    seen: new Set(),
    npcs: [],
    cars: [],
    nextCarId: 0,
    fireEngines: [],
    nextFireEngineId: 0,
    ambulances: [],
    nextAmbulanceId: 0,
    policeCars: [],
    nextPoliceCarId: 0,
    corpses: [],
    nextCorpseId: 0,
    crimeScenes: [],
    nextCrimeSceneId: 0,
    chalkOutlines: [],
    barriers: [],
    lastFireResponseSize: 0,
    carSpawnTimers: createCarSpawnTimers(),
    stationMasterScolding: false,
    hasCrossedTrainDoor: false,
    gunfirePanic: false,
    shootingMode: false,
    bullet: null,
    arrested: false,
    fires: [],
    ashPiles: [],
    fireEngineDispatchedThisTurn: false,
  };
  state.npcs = allMapNpcs().map(createNpcState);
  seedRoadTraffic();
  if (effect) playResetEffect();
  draw();
  renderInventory();
  writeLog(message);
}

async function loadMap(url, mapKey) {
  const text = await fetch(url).then((response) => response.text());
  const rows = text.split('\n').filter((line) => line && !line.startsWith(';'));
  const width = Math.max(...rows.map((row) => row.length));
  const grid = rows.map((row) => row.padEnd(width, '#').split(''));
  const walkable = [];
  const adjacentByCellType = {};
  const trainTiles = [];
  const trainDoorTiles = [];
  const npcs = [];
  const stairs = [];
  let start = { x: 1, y: 1 };
  grid.forEach((row, y) => row.forEach((cell, x) => {
    if (cell === 'P') start = { x, y };
    if (cell === 'U' || cell === '^' || cell === 'v' || cell === 'E' || cell === 'Q') stairs.push({ x, y, type: cell });
    const npcSymbol = npcMapSymbols[cell];
    if (npcSymbol) {
      if (npcSymbol.uniquePerMap && npcs.some((npc) => npc.mapSymbol === cell)) {
        throw new Error(`${mapKey} contains more than one unique ${cell} NPC.`);
      }
      const symbolIndex = npcs.filter((npc) => npc.mapSymbol === cell).length;
      const profileKey = cell === 'Z' ? `police-${symbolIndex}` : npcSymbol.profileKey;
      npcs.push({ x, y, mapKey, mapSymbol: cell, profileKey });
      grid[y][x] = '.';
    }
  }));

  grid.forEach((row, y) => row.forEach((cell, x) => {
    const tile = terrain[cell] ?? terrain[' '];
    if (!tile.blocks) walkable.push({ x, y });
    if (tile.trainWall) trainTiles.push({ x, y });
    if (isTrainDoorCell(grid, x, y)) trainDoorTiles.push({ x, y });
    if (!adjacentByCellType[cell]) adjacentByCellType[cell] = [];
    adjacentByCellType[cell].push(...neighborsOf({ x, y }).filter((point) => {
      const neighbor = terrain[grid[point.y]?.[point.x]] ?? terrain[' '];
      return !neighbor.blocks;
    }));
  }));

  Object.entries(adjacentByCellType).forEach(([cellType, points]) => {
    adjacentByCellType[cellType] = uniquePoints(points);
  });

  const jailCellTiles = mapKey === 'policeStation' ? lockedJailCellTiles(grid, start) : [];

  return { key: mapKey, grid, height: grid.length, width, start, stairs, npcs, walkable, adjacentByCellType, trainTiles, trainDoorTiles, jailCellTiles };
}

function lockedJailCellTiles(grid, start) {
  const queue = [start];
  const seen = new Set([positionKey(start.x, start.y)]);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (terrain[grid[current.y]?.[current.x]]?.jailDoor) continue;

    neighborsOf(current).forEach((neighbor) => {
      const key = positionKey(neighbor.x, neighbor.y);
      const tile = terrain[grid[neighbor.y]?.[neighbor.x]] ?? terrain[' '];
      if (seen.has(key) || tile.blocks) return;
      seen.add(key);
      queue.push(neighbor);
    });
  }

  return [...seen];
}

function tryMove(dx, dy) {
  state.facing = [dx, dy];
  const target = { x: state.player.x + dx, y: state.player.y + dy };
  const occupant = npcAt(target.x, target.y);
  if (occupant) return spendMinute(npcDialogue(occupant));
  if (carAt(target.x, target.y)) return killPlayer('You step into the road and a car hits you before the loop can blink.');
  const tile = tileAt(target.x, target.y);
  if (state.arrested && !isInsideLockedJailCell(target)) {
    writeLog('The cell door is locked. You can pace the cell, but you cannot leave before the loop ends.');
    return;
  }
  if (tile.blocks) {
    writeLog(tile.description);
    return;
  }
  const enteringTrainDoor = isTrainDoor(target.x, target.y);
  const shouldTriggerLoop = enteringTrainDoor && state.hasCrossedTrainDoor;
  state.player = target;
  closeReadableOverlay();
  if (enteringTrainDoor && !state.hasCrossedTrainDoor) state.hasCrossedTrainDoor = true;
  if (tile.track) alertStationMasterToTrackTrespass();
  if (tile.stairs || tile.stairsUp || tile.stairsDown || tile.officeEntrance || tile.officeExit) useStairs(tile);
  const item = itemAt(target.x, target.y);
  const pickupMessage = item ? pickUpItem(item) : null;
  const trainDoorMessage = enteringTrainDoor
    ? (shouldTriggerLoop ? 'You step back through the train door and deliberately end the loop.' : 'You cross the train door onto the platform. Returning through it will end this loop.')
    : null;
  spendMinute(pickupMessage ?? trainDoorMessage);
  if (shouldTriggerLoop) resetLoop('The train pulls away, then arrives again. The loop begins from the platform.');
}

function isInsideLockedJailCell(point) {
  return map.jailCellTiles?.includes(positionKey(point.x, point.y));
}

function interact() {
  const [dx, dy] = state.facing;
  const target = { x: state.player.x + dx, y: state.player.y + dy };
  const npc = npcAt(target.x, target.y);
  if (npc) return spendMinute(npcDialogue(npc));
  const tile = tileAt(target.x, target.y);
  if (tile.readableText) {
    showReadableOverlay(tile);
    return spendMinute(tile.interact ?? tile.description);
  }
  if (tile.interact) return spendMinute(tile.interact);
  writeLog(tile.description);
}

function spendMinute(message) {
  state.fireEngineDispatchedThisTurn = false;
  state.minutesLeft -= 1;
  runScheduledEvents();
  updateFireResponse();
  updateAmbulanceResponse();
  updateDetectiveResponse();
  updateFireTargets();
  updateParamedicCollection();
  updateDetectiveSceneWork();
  moveNpcs();
  if (updateFires()) return;
  updateFireResponse();
  if (moveFireEngines()) return;
  if (moveAmbulances()) return;
  if (movePoliceCars()) return;
  if (moveCars()) return;
  if (state.minutesLeft <= 0) return resetLoop('The two-hour loop expires. Everything snaps back to the moment you arrived.');
  draw();
  if (message) writeLog(message);
}


function isCarSpawner(item) {
  return item.type === 'carSpawnerLeft' || item.type === 'carSpawnerRight';
}

function carSpawnerItems() {
  return state.items.filter(isCarSpawner);
}

function createCarSpawnTimers() {
  return Object.fromEntries(placedItems
    .filter(isCarSpawner)
    .map((spawner) => [spawner.id, 0]));
}

function seedRoadTraffic() {
  carSpawnerItems().forEach((spawner) => spawnCar(spawner));
}

function spawnCar(spawner) {
  const mapKey = spawner.mapKey ?? 'station';
  if (state.fireEngineDispatchedThisTurn || trafficQueuedToSpawner(spawner)) return false;
  if (carAtOnMap(mapKey, spawner.x, spawner.y)) return false;
  state.cars.push({
    id: `car-${state.nextCarId}`,
    mapKey,
    x: spawner.x,
    y: spawner.y,
    dx: spawner.dx,
    sprite: spawner.dx < 0 ? 'carLeft' : 'carRight',
  });
  state.nextCarId += 1;
  return true;
}

function nextCarSpawnDelay() {
  return randomInteger(CAR_SPAWN_MINUTES, CAR_SPAWN_MAX_MINUTES);
}

function moveCars() {
  updateCarSpawns();
  const jammed = new Set();
  state.cars = state.cars
    .map((car) => {
      if (isCarBlockedByTrafficJam(car, jammed)) {
        jammed.add(car.id);
        return car;
      }
      return { ...car, x: car.x + car.dx };
    })
    .filter((car) => car.x >= 0 && car.x < maps[car.mapKey].width);

  killNpcsHitByCars();

  if (state.currentMapKey !== 'station') return false;
  const hitCar = carAt(state.player.x, state.player.y);
  if (!hitCar) return false;
  killPlayer('A car barrels down the road and knocks you out of the loop.');
  return true;
}

function killNpcsHitByCars() {
  const victims = state.npcs.filter((npc) => carAtOnMap(npc.mapKey, npc.x, npc.y));
  if (!victims.length) return;

  const victimKeys = new Set(victims.map((npc) => `${npc.mapKey}:${positionKey(npc.x, npc.y)}`));
  state.npcs = state.npcs.filter((npc) => !victimKeys.has(`${npc.mapKey}:${positionKey(npc.x, npc.y)}`));
  victims.forEach((npc) => killNpc(npc));
}

function killNpc(npc, cause = 'is struck by a passing car and killed') {
  leaveCorpse(npc);
  writeLog(`${npc.profile.name} ${cause}.`);
  if (npc.profile.key === 'stationMaster') {
    state.stationMasterScolding = false;
    writeLog('Without the station master, the brass-key door will not be tended this loop.');
  }
}

function isCarBlockedByTrafficJam(car, jammedCarIds = new Set()) {
  const nextX = car.x + car.dx;
  const roadBlockingEngine = state.fireEngines.find((engine) => (
    engine.mapKey === car.mapKey
    && engine.dx === car.dx
    && tileAtFor(engine.mapKey, engine.x, engine.y).road
    && engine.y === car.y
    && (engine.x === nextX || (car.dx > 0 ? engine.x > car.x : engine.x < car.x))
  ));
  if (roadBlockingEngine) return true;

  const queuedCarAhead = state.cars.find((other) => (
    other.id !== car.id
    && other.mapKey === car.mapKey
    && other.y === car.y
    && other.dx === car.dx
    && other.x === nextX
    && jammedCarIds.has(other.id)
  ));
  return Boolean(queuedCarAhead);
}

function trafficQueuedToSpawner(spawner) {
  const mapKey = spawner.mapKey ?? 'station';
  return state.cars.some((car) => (
    car.mapKey === mapKey
    && car.y === spawner.y
    && car.dx === spawner.dx
    && Math.abs(car.x - spawner.x) <= 1
  ));
}

function updateCarSpawns() {
  carSpawnerItems().forEach((spawner) => {
    const minutesUntilSpawn = state.carSpawnTimers[spawner.id] ?? 0;
    if (minutesUntilSpawn > 1) {
      state.carSpawnTimers[spawner.id] = minutesUntilSpawn - 1;
      return;
    }

    if (spawnCar(spawner)) state.carSpawnTimers[spawner.id] = nextCarSpawnDelay();
  });
}


function igniteFire() {
  const [dx, dy] = state.facing;
  const target = { x: state.player.x + dx, y: state.player.y + dy };
  if (!canBurn(state.currentMapKey, target.x, target.y)) {
    writeLog('The lighter sparks, but that tile will not burn. Buildings and solid obstacles stay untouched.');
    draw();
    return;
  }

  addFire(state.currentMapKey, target.x, target.y);
  writeLog('You flick the lighter and start a hungry fire. Every turn, one random neighboring tile may catch.');
  draw();
}

function updateFires() {
  extinguishAdjacentFires();
  killNpcsCaughtInFire();
  if (isFireAt(state.currentMapKey, state.player.x, state.player.y)) {
    killPlayer('Flames catch you before the loop can cool.');
    return true;
  }

  if (!state.fires.length) return false;

  const nextFire = randomItem(uniqueFirePoints(state.fires.flatMap((fire) => (
    neighborsOf(fire)
      .filter((neighbor) => canBurn(fire.mapKey, neighbor.x, neighbor.y))
      .map((neighbor) => ({ mapKey: fire.mapKey, ...neighbor }))
  ))));
  if (nextFire) addFire(nextFire.mapKey, nextFire.x, nextFire.y);
  killNpcsCaughtInFire();
  if (isFireAt(state.currentMapKey, state.player.x, state.player.y)) {
    killPlayer('The spreading fire overtakes you. The loop snaps back through smoke.');
    return true;
  }
  return false;
}


function updateFireTargets() {
  if (!state.fires.length) return;
  state.npcs.forEach((npc) => {
    const nearestFire = closestFireTo(npc);
    if (!nearestFire) return;
    if (isFirefighter(npc)) {
      npc.target = nearestFire;
      return;
    }
    npc.target = farthestWalkablePointFrom(npc.mapKey, nearestFire) ?? npc.target;
  });
}

function extinguishAdjacentFires() {
  const extinguished = new Set();
  state.npcs.filter(canExtinguishFire).forEach((npc) => {
    const fire = state.fires.find((candidate) => candidate.mapKey === npc.mapKey && manhattanDistance(npc, candidate) <= 1);
    if (!fire) return;
    extinguished.add(`${fire.mapKey}:${positionKey(fire.x, fire.y)}`);
  });
  if (!extinguished.size) return;
  state.fires.forEach((fire) => {
    if (extinguished.has(`${fire.mapKey}:${positionKey(fire.x, fire.y)}`)) addAshPile(fire.mapKey, fire.x, fire.y);
  });
  state.fires = state.fires.filter((fire) => !extinguished.has(`${fire.mapKey}:${positionKey(fire.x, fire.y)}`));
}

function killNpcsCaughtInFire() {
  const victims = state.npcs.filter((npc) => isFireAt(npc.mapKey, npc.x, npc.y));
  if (!victims.length) return;
  const victimKeys = new Set(victims.map((npc) => `${npc.mapKey}:${positionKey(npc.x, npc.y)}`));
  state.npcs = state.npcs.filter((npc) => !victimKeys.has(`${npc.mapKey}:${positionKey(npc.x, npc.y)}`));
  victims.forEach((npc) => killNpc(npc, 'is caught in the fire and killed'));
}

function addFire(mapKey, x, y) {
  if (isFireAt(mapKey, x, y)) return;
  state.fires.push({ mapKey, x, y });
}

function canBurn(mapKey, x, y) {
  return !isFireAt(mapKey, x, y) && !tileAtFor(mapKey, x, y).blocks;
}

function isFireAt(mapKey, x, y) {
  return state.fires.some((fire) => fire.mapKey === mapKey && fire.x === x && fire.y === y);
}

function addAshPile(mapKey, x, y) {
  if (state.ashPiles.some((ashPile) => ashPile.mapKey === mapKey && ashPile.x === x && ashPile.y === y)) return;
  state.ashPiles.push({ mapKey, x, y });
}

function closestFireTo(point) {
  return state.fires
    .filter((fire) => fire.mapKey === point.mapKey)
    .reduce((closest, fire) => {
      const distance = manhattanDistance(point, fire);
      if (!closest || distance < closest.distance) return { ...fire, distance };
      return closest;
    }, null);
}

function uniqueFirePoints(points) {
  const seen = new Set(state.fires.map((fire) => `${fire.mapKey}:${positionKey(fire.x, fire.y)}`));
  return points.filter((point) => {
    const key = `${point.mapKey}:${positionKey(point.x, point.y)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function leaveCorpse(npc) {
  const corpse = {
    id: `corpse-${state.nextCorpseId}`,
    mapKey: npc.mapKey,
    x: npc.x,
    y: npc.y,
    name: npc.profile.name,
  };
  state.nextCorpseId += 1;
  state.corpses.push(corpse);
  const scene = { id: `crime-scene-${state.nextCrimeSceneId}`, corpseId: corpse.id, mapKey: corpse.mapKey, x: corpse.x, y: corpse.y, status: 'awaitingAmbulance', detectiveDispatchMinute: null };
  state.nextCrimeSceneId += 1;
  state.crimeScenes.push(scene);
}

function markCorpseCollected(corpse) {
  const scene = state.crimeScenes.find((candidate) => candidate.corpseId === corpse.id);
  if (scene) {
    scene.status = 'bodyCollected';
    scene.detectiveDispatchMinute = elapsedMinutes() + 5;
  }
}

function manhattanDistance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function arrestPlayer() {
  if (state.arrested) return;
  state.currentMapKey = 'policeStation';
  map = maps.policeStation;
  state.player = { ...map.start };
  state.arrested = true;
  state.inventory = [];
  state.gunfirePanic = false;
  state.shootingMode = false;
  state.bullet = null;
  state.npcs = state.npcs
    .map((npc) => ({ ...npc, arrestingPlayer: false }));
  closeReadableOverlay();
  renderInventory();
  draw();
  writeLog('The police arrest you and lock you in a station cell. Time keeps moving, but you cannot leave before the loop ends.');
}

function killPlayer(message) {
  resetLoop(message);
}

function runScheduledEvents() {
  const currentMinute = elapsedMinutes();
  scheduledEvents.forEach((event) => {
    if (event.oncePerLoop && state.triggeredEventIds.has(event.id)) return;
    const triggerMinute = typeof event.triggerMinute === 'function' ? event.triggerMinute(state) : event.triggerMinute;
    if (currentMinute < triggerMinute) return;
    state.triggeredEventIds.add(event.id);
    event.effect();
  });
}

function setTileOverride(mapKey, x, y, tileType) {
  state.tileOverrides[mapKey] = { ...(state.tileOverrides[mapKey] ?? {}), [positionKey(x, y)]: tileType };
}


function isTrainDoor(x, y, mapKey = state.currentMapKey) {
  return Boolean(maps?.[mapKey]?.trainDoorTiles.some((point) => point.x === x && point.y === y));
}

function isTrainDoorCell(grid, x, y) {
  if (grid[y]?.[x] !== 'D') return false;
  return neighborsOf({ x, y }).some((point) => grid[point.y]?.[point.x] === 'T');
}

function stationDoorTile() {
  return tileAtFor('station', STATION_DOOR_X, STATION_DOOR_Y);
}

function openStationDoor() {
  if (!stationDoorTile().lockedDoor) return;
  setTileOverride('station', STATION_DOOR_X, STATION_DOOR_Y, 'D');
  writeLog('The station master unlocks the side-room door with a bright brass click.');
}

function closeStationDoor() {
  if (stationDoorTile().lockedDoor) return;
  setTileOverride('station', STATION_DOOR_X, STATION_DOOR_Y, 'X');
  writeLog('The station master locks the side-room door again.');
  if (isPlayerInsideStationSideRoom()) {
    writeLog('You hear the lock turn somewhere above. You are still inside the station side room.');
  }
}

function isPlayerInsideStationSideRoom() {
  if (state.currentMapKey === 'underground') return true;
  return state.currentMapKey === 'station'
    && state.player.x >= 96
    && state.player.x <= 105
    && state.player.y >= 7
    && state.player.y <= 11;
}

function useStairs(tile) {
  if (state.arrested) {
    writeLog('The cell door is locked. The loop clock keeps ticking without you.');
    return;
  }
  if (tile.officeEntrance) {
    movePlayerToMapStairs('officeReception', 'Q');
    writeLog('You step into the office block reception, where the workday loops in miniature.');
    return;
  }

  if (tile.officeExit) {
    movePlayerToMapStairs('station', 'E');
    writeLog('You leave the office block and return to the station district.');
    return;
  }

  if (tile.stairsUp) {
    const nextMapKey = nextOfficeFloorKey(1);
    if (nextMapKey) {
      movePlayerToMapStairs(nextMapKey, 'v');
      writeLog('You climb the office stairs to the floor above.');
    }
    return;
  }

  if (tile.stairsDown) {
    const nextMapKey = nextOfficeFloorKey(-1);
    if (nextMapKey) {
      movePlayerToMapStairs(nextMapKey, '^');
      writeLog('You descend the office stairs to the floor below.');
    }
    return;
  }

  if (state.currentMapKey === 'station') {
    movePlayerToMapStairs('underground', 'U');
    writeLog('You descend the narrow stairs into a small underground room.');
    return;
  }

  movePlayerToMapStairs('station', 'U');
  writeLog('You climb back up into the station side room.');
}

function nextOfficeFloorKey(direction) {
  const officeMapOrder = ['officeReception', 'officeFloor1', 'officeFloor2', 'officeFloor3', 'officeFloor4'];
  const nextIndex = officeMapOrder.indexOf(state.currentMapKey) + direction;
  return officeMapOrder[nextIndex];
}

function movePlayerToMapStairs(mapKey, stairType) {
  state.currentMapKey = mapKey;
  map = maps[mapKey];
  const destination = map.stairs.find((stair) => stair.type === stairType) ?? map.stairs[0] ?? map.start;
  state.player = { x: destination.x, y: destination.y };
}

function addLoopMinutes(minutes) {
  state.minutesLeft += minutes;
  state.loopLimit += minutes;
}

function updateTerrain(tileType, changes) {
  state.terrainOverrides[tileType] = { ...(state.terrainOverrides[tileType] ?? {}), ...changes };
}

function moveItem(itemId, position) {
  state.items = state.items.map((item) => (item.id === itemId ? { ...item, ...position } : item));
}

function moveNpcs() {
  updateGunfirePanicTargets();
  updateStationMasterScoldingTarget();
  const occupied = new Set(state.npcs.map((npc) => `${npc.mapKey}:${positionKey(npc.x, npc.y)}`));
  const remarks = [];

  state.npcs = state.npcs.map((npc) => {
    let traveler = npc;
    if (!state.gunfirePanic && traveler.x === traveler.target.x && traveler.y === traveler.target.y && !returningFireEngineFor(traveler) && !returningAmbulanceFor(traveler) && !returningPoliceCarFor(traveler)) {
      traveler = chooseNextNpcTarget(traveler);
    }

    const step = nextNpcStep(traveler, occupied);
    if (!step) return traveler;

    if (traveler.mapKey === state.currentMapKey && step.x === state.player.x && step.y === state.player.y) {
      if (isLawEnforcement(traveler) && state.gunfirePanic) {
        return { ...traveler, arrestingPlayer: true };
      }
      if (traveler.profile.key === 'stationMaster' && traveler.scoldingPlayer) {
        return finishStationMasterScolding(traveler, remarks);
      }
      remarks.push(npcBlockedRemark(traveler));
      return traveler;
    }

    const stepKey = `${traveler.mapKey}:${positionKey(step.x, step.y)}`;
    if (occupied.has(stepKey) || tileAtFor(traveler.mapKey, step.x, step.y).blocks) return traveler;

    occupied.delete(`${traveler.mapKey}:${positionKey(traveler.x, traveler.y)}`);
    occupied.add(stepKey);
    const moved = { ...traveler, x: step.x, y: step.y, chaseAxis: step.chaseAxis ?? traveler.chaseAxis };
    const returningVehicle = returningFireEngineFor(moved) ?? returningAmbulanceFor(moved) ?? returningPoliceCarFor(moved);
    if (returningVehicle && moved.x === returningVehicle.x && moved.y === returningVehicle.y) {
      occupied.delete(stepKey);
      return null;
    }
    handleNpcArrival(moved);
    return moved;
  }).filter(Boolean);

  const playerArrested = !state.arrested && state.npcs.some((npc) => npc.arrestingPlayer);
  if (playerArrested) {
    arrestPlayer();
    return;
  }

  remarks.forEach((remark) => writeLog(remark));
}

const STATION_DOOR_X = 94;
const STATION_DOOR_Y = 8;
const STATION_MASTER_DOOR_ATTENDANCE_POINT = { x: STATION_DOOR_X - 1, y: STATION_DOOR_Y };

function handleNpcArrival(npc) {
  if (npc.profile.key !== 'stationMaster') return;
  if (npc.x !== STATION_MASTER_DOOR_ATTENDANCE_POINT.x || npc.y !== STATION_MASTER_DOOR_ATTENDANCE_POINT.y) return;
  performStationMasterDoorActions(npc);
}


function stationMaster() {
  return state.npcs.find((npc) => npc.profile.key === 'stationMaster');
}

function alertStationMasterToTrackTrespass() {
  if (state.currentMapKey !== 'station') return;
  const master = stationMaster();
  if (!master || master.scoldingPlayer) return;
  master.scoldingPlayer = true;
  master.preScoldTarget = { ...master.target };
  master.target = { ...state.player };
  state.stationMasterScolding = true;
  writeLog('The station master spots you on the tracks and marches over to tell you off.');
}

function updateGunfirePanicTargets() {
  if (!state.gunfirePanic) return;
  state.npcs.forEach((npc) => {
    if (isLawEnforcement(npc)) {
      if (state.currentMapKey === npc.mapKey) npc.target = { ...state.player };
      return;
    }
    npc.target = farthestWalkablePointFromPlayer(npc.mapKey) ?? npc.target;
  });
}

function isLawEnforcement(npc) {
  return npc.profile.role?.includes('police');
}


function farthestWalkablePointFromPlayer(mapKey) {
  return farthestWalkablePointFrom(mapKey, state.player);
}

function farthestWalkablePointFrom(mapKey, threat) {
  return walkableTiles(mapKey).reduce((farthest, point) => {
    const distance = Math.abs(point.x - threat.x) + Math.abs(point.y - threat.y);
    if (!farthest || distance > farthest.distance) return { ...point, distance };
    return farthest;
  }, null);
}

function updateStationMasterScoldingTarget() {
  const master = stationMaster();
  if (!master?.scoldingPlayer) return;
  if (state.currentMapKey === 'station') master.target = { ...state.player };
}

function finishStationMasterScolding(npc, remarks) {
  remarks.push('The station master says, “Off the tracks! If I miss my duties because of this, I am doing them next.”');
  const resumed = { ...npc, scoldingPlayer: false };
  state.stationMasterScolding = false;
  return resumeStationMasterDuties(resumed);
}

function queueStationMasterDoorAction(action) {
  const master = stationMaster();
  if (!master) return;
  master.pendingDoorActions = [...(master.pendingDoorActions ?? []), action];
  if (master.scoldingPlayer) return;
  master.target = { ...STATION_MASTER_DOOR_ATTENDANCE_POINT };
  if (master.x === STATION_MASTER_DOOR_ATTENDANCE_POINT.x && master.y === STATION_MASTER_DOOR_ATTENDANCE_POINT.y) performStationMasterDoorActions(master);
}

function resumeStationMasterDuties(npc) {
  if (npc.pendingDoorActions?.length) return { ...npc, target: { ...STATION_MASTER_DOOR_ATTENDANCE_POINT }, preScoldTarget: null };
  return { ...npc, target: npc.preScoldTarget ?? npc.route[1] ?? npc.route[0], preScoldTarget: null };
}

function performStationMasterDoorActions(npc) {
  const actions = npc.pendingDoorActions ?? [];
  if (!actions.length) return;
  actions.forEach((action) => {
    if (action === 'open') openStationDoor();
    if (action === 'close') closeStationDoor();
  });
  npc.pendingDoorActions = [];
  npc.target = { x: 86, y: 8 };
}

function allMapNpcs() {
  return Object.values(maps).flatMap((loadedMap) => loadedMap.npcs);
}

function createNpcState(npc, index) {
  const profile = npcDefinitions.find((definition) => definition.key === npc.profileKey) ?? genericNpcDefinitions()[index % genericNpcDefinitions().length];
  const route = createNpcRoute(npc, profile);
  return { ...npc, profile, route, target: route[1] ?? route[0], pendingDoorActions: [] };
}

function genericNpcDefinitions() {
  return npcDefinitions.filter((definition) => (
    definition.key !== 'stationMaster'
    && definition.key !== 'policeGuard'
    && !definition.role?.includes('police')
  ));
}

function createNpcRoute(npc, profile) {
  const trainStops = maps[npc.mapKey].trainDoorTiles.length ? maps[npc.mapKey].trainDoorTiles : pointsAdjacentTo('T', npc.mapKey);
  const shopStops = pointsAdjacentTo('S', npc.mapKey);
  const kioskStops = pointsAdjacentTo('K', npc.mapKey);
  const walkStops = walkableTiles(npc.mapKey).filter((point) => !isTrainDoor(point.x, point.y, npc.mapKey));
  const platformStops = walkableTiles(npc.mapKey).filter((point) => nearbyTrain(point, 4, npc.mapKey));
  const start = { x: npc.x, y: npc.y };

  if (profile.routePreference === 'station master timed door') {
    return [start, { x: 86, y: 8 }];
  }

  if (profile.routePreference === 'commuter to train' && trainStops.length) {
    return [start, randomItem(trainStops)];
  }

  if (profile.routePreference === 'shopkeeper to kiosk') {
    const shopStop = closestPoint(start, shopStops) ?? start;
    const kioskStop = randomItem(kioskStops.length ? kioskStops : walkStops);
    return [shopStop, kioskStop];
  }

  if (profile.routePreference === 'police station patrol' || profile.routePreference === 'police station guard' || profile.routePreference === 'homeless seated by shop') {
    return [start, start];
  }

  if (profile.routePreference === 'lost tourist pacing near platform') {
    const pacingStops = uniquePoints([start, ...platformStops]);
    return [start, randomItem(pacingStops.length > 1 ? pacingStops.filter((point) => point.x !== start.x || point.y !== start.y) : walkStops)];
  }

  return [start, randomItem(walkStops)];
}


function npcDialogue(npc) {
  const line = randomItem(npc.profile.dialogue) ?? terrain.N.interact;
  return `${line} (${npc.profile.age}, ${npc.profile.gender}; goal: ${npc.profile.goal})`;
}

function npcBlockedRemark(npc) {
  return randomItem(npc.profile.blockedRemarks ?? npcBlockedRemarks) ?? randomItem(npcBlockedRemarks);
}

function nearbyTrain(point, distance, mapKey = state.currentMapKey) {
  for (let y = point.y - distance; y <= point.y + distance; y += 1) {
    for (let x = point.x - distance; x <= point.x + distance; x += 1) {
      if (tileAtFor(mapKey, x, y).trainWall || isTrainDoor(x, y, mapKey)) return true;
    }
  }
  return false;
}

function closestPoint(origin, points) {
  return points.reduce((closest, point) => {
    if (!closest) return point;
    const distance = Math.abs(point.x - origin.x) + Math.abs(point.y - origin.y);
    const closestDistance = Math.abs(closest.x - origin.x) + Math.abs(closest.y - origin.y);
    return distance < closestDistance ? point : closest;
  }, null);
}

function chooseNextNpcTarget(npc) {
  const currentTargetIndex = npc.route.findIndex((point) => point.x === npc.target.x && point.y === npc.target.y);
  const nextTarget = npc.route[currentTargetIndex === 0 ? 1 : 0];
  return { ...npc, target: nextTarget };
}


function nextNpcStep(npc, occupied) {
  if (isParamedic(npc)) return nextParamedicStep(npc, occupied) ?? nextStepToward(npc, occupied);
  if (isDetective(npc)) return nextDetectiveStep(npc, occupied) ?? nextStepToward(npc, occupied);
  if (isFirefighter(npc) && state.fires.some((fire) => fire.mapKey === npc.mapKey)) {
    return nextFirefighterStep(npc, occupied) ?? nextStepToward(npc, occupied);
  }
  if (isLawEnforcement(npc) && state.gunfirePanic && npc.mapKey === state.currentMapKey) {
    return nextPoliceChaseStep(npc, occupied) ?? nextStepToward(npc, occupied);
  }
  return nextStepToward(npc, occupied);
}


function nextPoliceChaseStep(npc, occupied) {
  const dx = state.player.x - npc.x;
  const dy = state.player.y - npc.y;
  if (dx === 0 || dy === 0) return null;

  const preferredAxes = npc.chaseAxis === 'horizontal'
    ? ['vertical', 'horizontal']
    : ['horizontal', 'vertical'];

  for (const axis of preferredAxes) {
    const step = chaseStepOnAxis(npc, axis, dx, dy, occupied);
    if (step) return { ...step, chaseAxis: axis };
  }

  return null;
}

function chaseStepOnAxis(npc, axis, dx, dy, occupied) {
  const step = axis === 'horizontal'
    ? { x: npc.x + Math.sign(dx), y: npc.y }
    : { x: npc.x, y: npc.y + Math.sign(dy) };
  const key = `${npc.mapKey}:${positionKey(step.x, step.y)}`;
  const targetKey = `${npc.mapKey}:${positionKey(npc.target.x, npc.target.y)}`;
  if (tileAtFor(npc.mapKey, step.x, step.y).blocks) return null;
  if (occupied.has(key) && key !== targetKey) return null;
  return step;
}

function nextStepToward(npc, occupied, { avoidFire = !isLawEnforcement(npc), avoidRoad = true } = {}) {
  const startKey = positionKey(npc.x, npc.y);
  const targetKey = positionKey(npc.target.x, npc.target.y);
  const distances = new Map([[startKey, 0]]);
  const cameFrom = new Map([[startKey, null]]);
  const queue = [{ x: npc.x, y: npc.y, cost: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift();
    if (!current) break;
    if (current.cost > distances.get(positionKey(current.x, current.y))) continue;
    if (positionKey(current.x, current.y) === targetKey) break;

    neighborsOf(current).forEach((neighbor) => {
      const key = positionKey(neighbor.x, neighbor.y);
      const tile = tileAtFor(npc.mapKey, neighbor.x, neighbor.y);
      if (tile.blocks) return;
      if (avoidFire && isFireAt(npc.mapKey, neighbor.x, neighbor.y)) return;
      if (occupied.has(`${npc.mapKey}:${key}`) && key !== targetKey) return;
      const roadCost = avoidRoad && tile.road && key !== targetKey ? NPC_ROAD_PATH_COST : 1;
      const nextCost = current.cost + roadCost;
      if (distances.has(key) && distances.get(key) <= nextCost) return;
      distances.set(key, nextCost);
      cameFrom.set(key, current);
      queue.push({ ...neighbor, cost: nextCost });
    });
  }

  if (!cameFrom.has(targetKey)) return null;
  let step = npc.target;
  let previous = cameFrom.get(targetKey);
  while (previous && positionKey(previous.x, previous.y) !== startKey) {
    step = previous;
    previous = cameFrom.get(positionKey(previous.x, previous.y));
  }
  return { x: step.x, y: step.y };
}

function nextVehicleStepToward(vehicle) {
  return nextStepToward(vehicle, new Set(), { avoidFire: false, avoidRoad: false });
}

function neighborsOf(point) {
  return [
    { x: point.x + 1, y: point.y },
    { x: point.x - 1, y: point.y },
    { x: point.x, y: point.y + 1 },
    { x: point.x, y: point.y - 1 },
  ];
}

function pointsAdjacentTo(cellType, mapKey = state.currentMapKey) {
  return maps[mapKey].adjacentByCellType[cellType] ?? [];
}

function walkableTiles(mapKey = state.currentMapKey) {
  return maps[mapKey].walkable;
}

function uniquePoints(points) {
  const seen = new Set();
  return points.filter((point) => {
    const key = positionKey(point.x, point.y);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function positionKey(x, y) {
  return `${x},${y}`;
}

function draw() {
  world.removeChildren().forEach((child) => child.destroy());
  const visible = visibleTiles();
  visible.forEach((key) => state.seen.add(key));
  const bounds = visibleDrawBounds();
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      drawTile(x, y, visible.has(`${x},${y}`));
    }
  }
  state.items
    .filter((item) => !isCarSpawner(item) && (item.mapKey ?? 'station') === state.currentMapKey)
    .forEach((item) => {
      if (visible.has(`${item.x},${item.y}`)) drawItem(item, true);
    });
  state.chalkOutlines.filter((outline) => outline.mapKey === state.currentMapKey).forEach((outline) => {
    if (visible.has(`${outline.x},${outline.y}`)) drawSprite(outline.x, outline.y, 'chalkOutline', true);
  });
  state.barriers.filter((barrier) => barrier.mapKey === state.currentMapKey).forEach((barrier) => {
    if (visible.has(`${barrier.x},${barrier.y}`)) drawSprite(barrier.x, barrier.y, 'barrier', true);
  });
  state.ashPiles.filter((ashPile) => ashPile.mapKey === state.currentMapKey).forEach((ashPile) => {
    if (visible.has(`${ashPile.x},${ashPile.y}`)) drawSprite(ashPile.x, ashPile.y, 'ashPile', true);
  });
  state.corpses.filter((corpse) => corpse.mapKey === state.currentMapKey).forEach((corpse) => {
    if (visible.has(`${corpse.x},${corpse.y}`)) drawSprite(corpse.x, corpse.y, 'corpse', true);
  });
  state.fires.filter((fire) => fire.mapKey === state.currentMapKey).forEach((fire) => {
    if (visible.has(`${fire.x},${fire.y}`)) drawSprite(fire.x, fire.y, 'fire', true);
  });
  state.cars.filter((car) => car.mapKey === state.currentMapKey).forEach((car) => {
    if (visible.has(`${car.x},${car.y}`)) drawSprite(car.x, car.y, car.sprite, true);
  });
  state.ambulances.filter((ambulance) => ambulance.mapKey === state.currentMapKey).forEach((ambulance) => {
    if (visible.has(`${ambulance.x},${ambulance.y}`)) drawSprite(ambulance.x, ambulance.y, ambulance.sprite, true);
  });
  state.policeCars.filter((car) => car.mapKey === state.currentMapKey).forEach((car) => {
    if (visible.has(`${car.x},${car.y}`)) drawSprite(car.x, car.y, car.sprite, true);
  });
  state.fireEngines.filter((engine) => engine.mapKey === state.currentMapKey).forEach((engine) => {
    if (visible.has(`${engine.x},${engine.y}`)) drawSprite(engine.x, engine.y, engine.sprite, true);
  });
  state.npcs.filter((npc) => npc.mapKey === state.currentMapKey).forEach((npc) => {
    if (visible.has(`${npc.x},${npc.y}`)) drawSprite(npc.x, npc.y, npcSprite(npc), true);
  });
  if (state.bullet?.path[state.bullet.index]) {
    const bullet = state.bullet.path[state.bullet.index];
    if (visible.has(`${bullet.x},${bullet.y}`)) drawSprite(bullet.x, bullet.y, 'bullet', true);
  }
  drawSprite(state.player.x, state.player.y, state.shootingMode ? 'playerGun' : 'player', true);
  world.x = Math.round(app.screen.width / 2 - (state.player.x + 0.5) * TILE_SIZE);
  world.y = Math.round(app.screen.height / 2 - (state.player.y + 0.5) * TILE_SIZE);
  hud.textContent = `Loop ${loopCount} · Minute ${elapsedMinutes()} / ${state.loopLimit} · ${state.minutesLeft} min left`;
}

function visibleDrawBounds() {
  const halfTilesWide = Math.ceil(app.screen.width / TILE_SIZE / 2) + 2;
  const halfTilesHigh = Math.ceil(app.screen.height / TILE_SIZE / 2) + 2;
  return {
    minX: Math.max(0, state.player.x - halfTilesWide),
    maxX: Math.min(map.width - 1, state.player.x + halfTilesWide),
    minY: Math.max(0, state.player.y - halfTilesHigh),
    maxY: Math.min(map.height - 1, state.player.y + halfTilesHigh),
  };
}

function npcSprite(npc) {
  if (npc.profile.key === 'stationMaster') return 'M';
  if (isFirefighter(npc)) return 'firefighter';
  if (isParamedic(npc)) return 'paramedic';
  if (isDetective(npc)) return 'detective';
  if (isLawEnforcement(npc)) return 'police';
  if (npc.profile.key === 'homelessPerson') return 'homeless';
  return `npc-${npc.profile.key}`;
}

function drawItem(item, visible) {
  const definition = itemDefinitions[item.type];
  if (!visible) return;
  const g = new Graphics();
  const px = item.x * TILE_SIZE;
  const py = item.y * TILE_SIZE;
  g.circle(px + 16, py + 16, 7).fill(definition.color);
  g.circle(px + 16, py + 16, 5).stroke({ color: 0x20242a, width: 2 });
  g.moveTo(px + 16, py + 16).lineTo(px + 16, py + 11).lineTo(px + 19, py + 16).stroke({ color: 0x20242a, width: 1.5 });
  g.rect(px + 13, py + 7, 6, 3).fill(0xd97706);
  world.addChild(g);
}

function drawTile(x, y, isVisible) {
  const remembered = state.seen.has(`${x},${y}`);
  const rememberedOnly = remembered && !isVisible;
  if (!isVisible && !remembered) return drawSprite(x, y, 'unknown', true);
  drawSprite(x, y, isTrainDoor(x, y) ? 'trainDoor' : map.grid[y][x], true, rememberedOnly, rememberedOnly ? 0.67 : 1);
  if (isVisible && tileAt(x, y).readableText) drawReadableBadge(x, y);
}


function drawSprite(x, y, sprite, visible, desaturated = false, alpha = 1) {
  const g = new Graphics();
  g.alpha = alpha;
  const tone = (color) => (desaturated ? desaturate(color) : color);
  const fill = (color) => (visible ? tone(color) : 0x000000);
  const px = x * TILE_SIZE;
  const py = y * TILE_SIZE;
  const inset = 3;

  g.rect(px, py, TILE_SIZE - 1, TILE_SIZE - 1).fill(fill(baseColorFor(sprite)));
  if (!visible) {
    world.addChild(g);
    return;
  }

  switch (sprite) {
    case '#':
      g.rect(px + 2, py + 2, 12, 6).fill(tone(0x4d5868));
      g.rect(px + 17, py + 2, 13, 6).fill(tone(0x4d5868));
      g.rect(px + 5, py + 12, 20, 5).fill(tone(0x2a303a));
      g.rect(px + 2, py + 22, 12, 6).fill(tone(0x4d5868));
      g.rect(px + 17, py + 22, 13, 6).fill(tone(0x4d5868));
      break;
    case '.':
    case 'P':
      g.circle(px + 8, py + 8, 1.5).fill(tone(0x7b8189));
      g.circle(px + 23, py + 19, 1.5).fill(tone(0x7b8189));
      break;
    case 'h':
      g.rect(px, py + 14, TILE_SIZE - 1, 3).fill(tone(0xf8fafc));
      g.rect(px + 13, py + 14, 6, 3).fill(tone(0x1f2933));
      break;
    case '-':
      g.rect(px, py, TILE_SIZE - 1, 5).fill(tone(0xc7cbd1));
      g.rect(px, py + 5, TILE_SIZE - 1, 3).fill(tone(0xf6c453));
      g.circle(px + 8, py + 18, 1.5).fill(tone(0x9aa1aa));
      g.circle(px + 23, py + 25, 1.5).fill(tone(0x9aa1aa));
      break;
    case '=':
      g.rect(px + 5, py, 5, TILE_SIZE - 1).fill(tone(0x0f1115));
      g.rect(px + 22, py, 5, TILE_SIZE - 1).fill(tone(0x0f1115));
      g.rect(px + 2, py + 6, 28, 4).fill(tone(0x656b72));
      g.rect(px + 2, py + 22, 28, 4).fill(tone(0x656b72));
      break;
    case 'T':
      g.roundRect(px + 1, py + 3, TILE_SIZE - 2, TILE_SIZE - 6, 4).fill(tone(0x1f4f78));
      g.rect(px + 1, py + 4, TILE_SIZE - 2, 4).fill(tone(0xd6dde6));
      g.rect(px + 1, py + 24, TILE_SIZE - 2, 3).fill(tone(0xf6c453));
      g.rect(px + 7, py + 9, 18, 9).fill(tone(0x8bd3ff));
      g.rect(px + 9, py + 11, 14, 5).fill(tone(0xdff6ff));
      g.rect(px + 29, py + 5, 2, 22).fill(tone(0x102338));
      break;
    case 'D':
      g.rect(px + 6, py + 4, 20, 24).fill(tone(0x6f4724));
      g.circle(px + 21, py + 16, 2).fill(tone(0xf6c453));
      break;
    case 'trainDoor':
      g.roundRect(px + 4, py + 2, 24, 28, 3).fill(tone(0x1f4f78));
      g.rect(px + 7, py + 5, 18, 22).fill(tone(0xb8c1cc));
      g.rect(px + 9, py + 7, 14, 7).fill(tone(0x8bd3ff));
      g.rect(px + 15, py + 5, 2, 22).fill(tone(0x24496f));
      g.circle(px + 12, py + 19, 2).fill(tone(0xf6c453));
      g.circle(px + 20, py + 19, 2).fill(tone(0xf6c453));
      break;
    case 'W':
      g.rect(px + 4, py + 5, 24, 22).fill(tone(0x3d4c5d));
      g.rect(px + 7, py + 8, 18, 16).fill(tone(0x79d2ff));
      g.rect(px + 15, py + 8, 2, 16).fill(tone(0xe8f8ff));
      g.rect(px + 7, py + 15, 18, 2).fill(tone(0xe8f8ff));
      g.rect(px + 9, py + 10, 5, 3).fill(tone(0xbfefff));
      break;
    case '~':
      g.moveTo(px + 5, py + 25).quadraticCurveTo(px + 9, py + 6, px + 13, py + 25).fill(tone(0x55a85e));
      g.moveTo(px + 14, py + 25).quadraticCurveTo(px + 18, py + 8, px + 23, py + 25).fill(tone(0x6ec56f));
      break;
    case 'B':
      g.rect(px + 5, py + 10, 22, 5).fill(tone(0xb4814d));
      g.rect(px + 5, py + 18, 22, 5).fill(tone(0xb4814d));
      g.rect(px + 8, py + 23, 3, 6).fill(tone(0x4b3522));
      g.rect(px + 21, py + 23, 3, 6).fill(tone(0x4b3522));
      break;
    case 'C':
    case 'carLeft':
    case 'carRight':
    case 'fireEngine':
    case 'ambulance':
    case 'policeCar':
      g.roundRect(px + 4, py + 9, 24, 14, 4).fill(tone(vehicleColorFor(sprite)));
      g.rect(px + 10, py + 5, 12, 7).fill(tone(0x79d2ff));
      g.circle(px + 10, py + 24, 3).fill(tone(0x15181f));
      g.circle(px + 23, py + 24, 3).fill(tone(0x15181f));
      if (sprite === 'fireEngine') {
        g.rect(px + 8, py + 12, 16, 3).fill(tone(0xf8fafc));
        g.rect(px + 14, py + 6, 4, 8).fill(tone(0xf8fafc));
        g.circle(px + 23, py + 7, 2).fill(tone(0x38bdf8));
      }
      if (sprite === 'ambulance') {
        g.rect(px + 8, py + 12, 16, 3).fill(tone(0xef4444));
        g.rect(px + 14, py + 7, 4, 13).fill(tone(0xef4444));
        g.circle(px + 23, py + 7, 2).fill(tone(0x38bdf8));
      }
      if (sprite === 'policeCar') {
        g.rect(px + 5, py + 13, 22, 3).fill(tone(0xf8fafc));
        g.circle(px + 14, py + 7, 2).fill(tone(0xef4444));
        g.circle(px + 19, py + 7, 2).fill(tone(0x38bdf8));
      }
      g.circle(px + (sprite === 'carLeft' ? 6 : 26), py + 16, 2).fill(tone(0xfef3c7));
      break;
    case 'S':
      g.rect(px + 5, py + 7, 22, 18).fill(tone(0xa855f7));
      g.rect(px + 7, py + 9, 18, 6).fill(tone(0xe8dcff));
      g.rect(px + 13, py + 17, 6, 8).fill(tone(0x5b2b82));
      break;
    case 'E':
    case 'Q':
      g.rect(px + 5, py + 4, 22, 24).fill(tone(0x334155));
      g.rect(px + 8, py + 7, 16, 18).fill(tone(0x93c5fd));
      g.rect(px + 15, py + 7, 2, 18).fill(tone(0xe0f2fe));
      g.circle(px + (sprite === 'E' ? 21 : 11), py + 16, 2).fill(tone(0xfacc15));
      break;
    case 'r':
      g.rect(px + 4, py + 13, 24, 12).fill(tone(0x8b5cf6));
      g.rect(px + 7, py + 9, 18, 5).fill(tone(0xc4b5fd));
      g.rect(px + 10, py + 17, 12, 2).fill(tone(0xf8fafc));
      break;
    case 'j':
      g.rect(px + 3, py + 3, 26, 26).fill(tone(0x1f2937));
      for (let bar = 6; bar <= 24; bar += 6) g.rect(px + bar, py + 2, 3, 28).fill(tone(0x94a3b8));
      g.rect(px + 3, py + 8, 26, 3).fill(tone(0x64748b));
      g.rect(px + 3, py + 22, 26, 3).fill(tone(0x64748b));
      break;
    case 'c':
      g.rect(px + 4, py + 3, 24, 26).fill(tone(0x111827));
      for (let bar = 8; bar <= 23; bar += 5) g.rect(px + bar, py + 4, 3, 24).fill(tone(0xcbd5e1));
      g.circle(px + 22, py + 16, 2).fill(tone(0xfacc15));
      break;
    case 'o':
      g.rect(px + 5, py + 10, 22, 13).fill(tone(0x94a3b8));
      g.rect(px + 8, py + 13, 8, 6).fill(tone(0xe2e8f0));
      g.rect(px + 18, py + 13, 6, 2).fill(tone(0x475569));
      g.rect(px + 8, py + 23, 3, 6).fill(tone(0x475569));
      g.rect(px + 21, py + 23, 3, 6).fill(tone(0x475569));
      break;
    case 'p':
      g.rect(px + 10, py + 21, 12, 7).fill(tone(0x92400e));
      g.circle(px + 12, py + 16, 6).fill(tone(0x22c55e));
      g.circle(px + 20, py + 14, 7).fill(tone(0x16a34a));
      g.circle(px + 16, py + 9, 5).fill(tone(0x4ade80));
      break;
    case '^':
    case 'v':
      g.rect(px + 4, py + 4, 24, 24).fill(tone(sprite === '^' ? 0x22c55e : 0xf97316));
      if (sprite === '^') {
        g.moveTo(px + 16, py + 7).lineTo(px + 24, py + 18).lineTo(px + 19, py + 18).lineTo(px + 19, py + 25).lineTo(px + 13, py + 25).lineTo(px + 13, py + 18).lineTo(px + 8, py + 18).fill(tone(0xf8fafc));
      } else {
        g.moveTo(px + 16, py + 25).lineTo(px + 24, py + 14).lineTo(px + 19, py + 14).lineTo(px + 19, py + 7).lineTo(px + 13, py + 7).lineTo(px + 13, py + 14).lineTo(px + 8, py + 14).fill(tone(0xf8fafc));
      }
      break;
    case 'Y':
      g.rect(px + 6, py + 8, 20, 18).fill(tone(0x0ea5e9));
      g.rect(px + 8, py + 11, 16, 12).fill(tone(0xf8fafc));
      g.rect(px + 10, py + 13, 12, 2).fill(tone(0x1d2430));
      g.rect(px + 10, py + 17, 8, 2).fill(tone(0x1d2430));
      g.rect(px + 8, py + 4, 16, 5).fill(tone(0x0369a1));
      break;
    case 'K':
      g.rect(px + 7, py + 8, 18, 18).fill(tone(0xf6c453));
      g.rect(px + 5, py + 5, 22, 5).fill(tone(0xd97706));
      g.circle(px + 16, py + 17, 5).fill(tone(0xfff5cc));
      g.moveTo(px + 16, py + 17).lineTo(px + 16, py + 13).lineTo(px + 19, py + 17).stroke({ color: tone(0x20242a), width: 1.5 });
      break;
    case 'A':
      g.rect(px + 4, py + 6, 24, 15).fill(tone(0x0f766e));
      g.rect(px + 7, py + 9, 18, 2).fill(tone(0xccfbf1));
      g.rect(px + 7, py + 14, 14, 2).fill(tone(0xccfbf1));
      g.rect(px + 8, py + 21, 3, 8).fill(tone(0x20242a));
      g.rect(px + 21, py + 21, 3, 8).fill(tone(0x20242a));
      break;
    case 'L':
      g.rect(px + 15, py + 9, 3, 19).fill(tone(0x4b5563));
      g.circle(px + 16, py + 7, 6).fill(tone(0xfff3a3));
      g.circle(px + 16, py + 7, 3).fill(tone(0xfacc15));
      break;
    case 'V':
      g.roundRect(px + 7, py + 4, 18, 24, 3).fill(tone(0xdc2626));
      g.rect(px + 10, py + 7, 8, 12).fill(tone(0x7dd3fc));
      g.rect(px + 20, py + 8, 2, 10).fill(tone(0xfef3c7));
      g.rect(px + 11, py + 23, 10, 2).fill(tone(0x111827));
      break;
    case 'G':
      g.roundRect(px + 6, py + 12, 20, 14, 2).fill(tone(0x8b5a2b));
      g.rect(px + 12, py + 8, 8, 5).stroke({ color: tone(0x3f2a17), width: 2 });
      g.rect(px + 9, py + 16, 14, 2).fill(tone(0xc49a6c));
      break;
    case 'R':
      g.rect(px + 5, py + 8, 6, 18).fill(tone(0x475569));
      g.rect(px + 21, py + 8, 6, 18).fill(tone(0x475569));
      g.rect(px + 10, py + 14, 12, 4).fill(tone(0xe11d48));
      break;
    case 'O':
      g.circle(px + 16, py + 16, 10).fill(tone(0xf8fafc));
      g.circle(px + 16, py + 16, 8).stroke({ color: tone(0x1f2937), width: 2 });
      g.moveTo(px + 16, py + 16).lineTo(px + 16, py + 10).lineTo(px + 20, py + 16).stroke({ color: tone(0x1f2937), width: 1.5 });
      break;
    case 'fire':
      g.circle(px + 16, py + 18, 11).fill(tone(0xdc2626));
      g.circle(px + 12, py + 14, 7).fill(tone(0xf97316));
      g.circle(px + 19, py + 13, 6).fill(tone(0xfacc15));
      g.moveTo(px + 16, py + 5).lineTo(px + 24, py + 21).lineTo(px + 8, py + 21).fill(tone(0xffedd5));
      break;
    case 'ashPile':
      g.ellipse(px + 16, py + 22, 11, 5).fill(tone(0x57534e));
      g.ellipse(px + 11, py + 20, 5, 3).fill(tone(0x78716c));
      g.ellipse(px + 20, py + 19, 6, 4).fill(tone(0x44403c));
      g.circle(px + 15, py + 18, 2).fill(tone(0xa8a29e));
      break;
    case 'bullet':
      g.circle(px + 16, py + 16, 4).fill(tone(0xf8fafc));
      g.circle(px + 16, py + 16, 2).fill(tone(0xfacc15));
      break;
    case 'corpse':
      g.ellipse(px + 16, py + 20, 11, 5).fill(tone(0x111827));
      g.circle(px + 8, py + 18, 4).fill(tone(0xffc0a8));
      g.rect(px + 12, py + 16, 14, 5).fill(tone(0x334155));
      break;
    case 'chalkOutline':
      g.ellipse(px + 16, py + 20, 11, 5).stroke({ color: tone(0xf8fafc), width: 2 });
      g.circle(px + 8, py + 18, 4).stroke({ color: tone(0xf8fafc), width: 2 });
      break;
    case 'barrier':
      g.rect(px + 3, py + 12, 26, 4).fill(tone(0xfacc15));
      g.rect(px + 3, py + 19, 26, 4).fill(tone(0xfacc15));
      g.rect(px + 5, py + 12, 4, 11).fill(tone(0x111827));
      g.rect(px + 22, py + 12, 4, 11).fill(tone(0x111827));
      break;
    case 'firefighter':
      g.circle(px + 16, py + 8, 5).fill(tone(0xffc0a8));
      g.rect(px + 9, py + 2, 14, 5).fill(tone(0xfacc15));
      g.roundRect(px + 9, py + 14, 14, 12, 3).fill(tone(0xf97316));
      g.rect(px + 11, py + 16, 10, 2).fill(tone(0xf8fafc));
      g.rect(px + 6, py + 18, 20, 3).fill(tone(0x94a3b8));
      g.rect(px + 9, py + 26, 5, 4).fill(tone(0x111827));
      g.rect(px + 18, py + 26, 5, 4).fill(tone(0x111827));
      break;
    case 'paramedic':
      g.circle(px + 16, py + 8, 5).fill(tone(0xffc0a8));
      g.roundRect(px + 9, py + 14, 14, 12, 3).fill(tone(0xf8fafc));
      g.rect(px + 11, py + 16, 10, 2).fill(tone(0xef4444));
      g.rect(px + 15, py + 14, 2, 12).fill(tone(0xef4444));
      g.rect(px + 9, py + 26, 5, 4).fill(tone(0x111827));
      g.rect(px + 18, py + 26, 5, 4).fill(tone(0x111827));
      break;
    case 'detective':
      g.circle(px + 16, py + 8, 5).fill(tone(0xffc0a8));
      g.rect(px + 9, py + 3, 14, 4).fill(tone(0x4b5563));
      g.roundRect(px + 9, py + 14, 14, 12, 3).fill(tone(0x334155));
      g.rect(px + 12, py + 14, 8, 12).fill(tone(0x94a3b8));
      g.rect(px + 9, py + 26, 5, 4).fill(tone(0x111827));
      g.rect(px + 18, py + 26, 5, 4).fill(tone(0x111827));
      break;
    case 'police':
      g.circle(px + 16, py + 8, 5).fill(tone(0xffc0a8));
      g.rect(px + 8, py + 3, 16, 5).fill(tone(0x111827));
      g.rect(px + 10, py + 1, 12, 3).fill(tone(0x1d4ed8));
      g.circle(px + 16, py + 4, 2).fill(tone(0xfacc15));
      g.roundRect(px + 9, py + 14, 14, 12, 3).fill(tone(0x1d4ed8));
      g.rect(px + 11, py + 16, 10, 2).fill(tone(0xf8fafc));
      g.rect(px + 15, py + 14, 2, 12).fill(tone(0x0f172a));
      g.circle(px + 12, py + 18, 1.5).fill(tone(0xfacc15));
      g.rect(px + 6, py + 16, 4, 10).fill(tone(0x0f172a));
      g.rect(px + 22, py + 16, 4, 10).fill(tone(0x0f172a));
      g.rect(px + 9, py + 26, 5, 4).fill(tone(0x111827));
      g.rect(px + 18, py + 26, 5, 4).fill(tone(0x111827));
      break;
    case 'homeless':
      g.ellipse(px + 16, py + 11, 5, 4).fill(tone(0xd4a373));
      g.roundRect(px + 8, py + 16, 16, 10, 4).fill(tone(0x8b5a2b));
      g.rect(px + 6, py + 21, 20, 7).fill(tone(0x6b4226));
      g.circle(px + 25, py + 22, 3).stroke({ color: tone(0xd1d5db), width: 1.5 });
      g.rect(px + 11, py + 26, 5, 3).fill(tone(0x374151));
      g.rect(px + 17, py + 26, 5, 3).fill(tone(0x374151));
      break;
    case 'N':
    case 'M':
    case 'npc-commuter':
    case 'npc-shopkeeper':
    case 'npc-tourist':
    case 'npc-courier':
    case 'npc-accountant':
    case 'npc-janitor':
    case 'npc-engineer':
    case 'npc-intern':
    case 'npc-solicitor':
    case 'npc-inventor':
    case 'npc-conductor':
    case 'npc-violinist':
    case 'npc-porter':
    case 'player':
    case 'playerGun':
      g.circle(px + 16, py + 9, 5).fill(tone(characterSkinFor(sprite)));
      g.roundRect(px + 10, py + 15, 12, 11, 3).fill(tone(characterClothingFor(sprite)));
      if (sprite === 'playerGun') g.rect(px + 21, py + 17, 8, 3).fill(tone(0x111827));
      if (sprite === 'npc-courier') g.rect(px + 10, py + 4, 12, 3).fill(tone(0xfacc15));
      if (sprite === 'npc-violinist') g.rect(px + 6, py + 21, 20, 3).fill(tone(0x7c2d12));
      g.rect(px + 8, py + 26, 6, 4).fill(tone(0x20242a));
      g.rect(px + 18, py + 26, 6, 4).fill(tone(0x20242a));
      break;
    case 'blood':
      g.circle(px + 16, py + 16, 8).fill(tone(0x7f1d1d));
      g.circle(px + 10, py + 20, 4).fill(tone(0x991b1b));
      g.circle(px + 22, py + 11, 3).fill(tone(0x450a0a));
      break;
    case 'unknown':
      break;
    default:
      g.rect(px + inset, py + inset, TILE_SIZE - inset * 2, TILE_SIZE - inset * 2).fill(fill(tileAt(x, y).color));
  }

  world.addChild(g);
}

function drawReadableBadge(x, y) {
  const g = new Graphics();
  const px = x * TILE_SIZE;
  const py = y * TILE_SIZE;
  g.roundRect(px + 20, py + 3, 9, 9, 2).fill(0xf6f1df);
  g.rect(px + 23, py + 5, 3, 1.5).fill(0x1d2430);
  g.rect(px + 23, py + 8, 3, 1.5).fill(0x1d2430);
  world.addChild(g);
}


function characterSkinFor(sprite) {
  return {
    M: 0xbfdbfe,
    'npc-tourist': 0xf9d4a9,
    'npc-courier': 0xb7794f,
    'npc-accountant': 0xf1c27d,
    'npc-janitor': 0x8d5524,
    'npc-engineer': 0xc68642,
    'npc-solicitor': 0xe0ac69,
  }[sprite] ?? (sprite === 'player' || sprite === 'playerGun' ? 0x61dafb : 0xffc0a8);
}

function characterClothingFor(sprite) {
  return {
    M: 0x2563eb,
    'npc-commuter': 0x7c3aed,
    'npc-shopkeeper': 0xf59e0b,
    'npc-tourist': 0xec4899,
    'npc-courier': 0x10b981,
    'npc-accountant': 0x64748b,
    'npc-janitor': 0xeab308,
    'npc-engineer': 0x14b8a6,
    'npc-intern': 0x22c55e,
    'npc-solicitor': 0x334155,
    'npc-inventor': 0xa16207,
    'npc-conductor': 0x4338ca,
    'npc-violinist': 0xbe123c,
    'npc-porter': 0xdc2626,
  }[sprite] ?? (sprite === 'player' || sprite === 'playerGun' ? 0x1d8fb8 : 0xff8a65);
}

function vehicleColorFor(sprite) {
  if (sprite === 'C') return 0xa5adbb;
  if (sprite === 'ambulance') return 0xf8fafc;
  if (sprite === 'policeCar') return 0x1d4ed8;
  return 0xef4444;
}

function baseColorFor(sprite) {
  if (sprite === 'unknown') return 0x000000;
  if (sprite === 'player' || sprite === 'playerGun') return 0x264757;
  if (sprite === 'bullet') return 0x000000;
  if (sprite === 'fire') return 0x451a03;
  if (sprite === 'ashPile') return 0x292524;
  if (sprite === 'corpse' || sprite === 'chalkOutline' || sprite === 'barrier') return 0x000000;
  if (sprite === 'trainDoor') return 0x102338;
  if (sprite === 'carLeft' || sprite === 'carRight' || sprite === 'fireEngine' || sprite === 'ambulance' || sprite === 'policeCar') return 0x1f2933;
  if (sprite === 'firefighter') return 0x7c2d12;
  if (sprite === 'paramedic') return 0xf8fafc;
  if (sprite === 'detective' || sprite === 'police') return 0x0f172a;
  if (sprite === 'homeless') return 0x4a2f1b;
  if (sprite.startsWith?.('npc-')) return characterClothingFor(sprite);
  return terrain[sprite]?.color ?? 0x000000;
}

function visibleTiles() {
  const visible = new Set();
  for (let y = state.player.y - SIGHT_RADIUS; y <= state.player.y + SIGHT_RADIUS; y += 1) {
    for (let x = state.player.x - SIGHT_RADIUS; x <= state.player.x + SIGHT_RADIUS; x += 1) {
      if (lineClear(state.player.x, state.player.y, x, y)) visible.add(`${x},${y}`);
    }
  }
  return visible;
}

function lineClear(x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (true) {
    if (x === x1 && y === y1) return true;
    if (!(x === x0 && y === y0) && blocksView(x, y)) return false;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

function describeTile(x, y) {
  const visible = visibleTiles();
  if (!state.seen.has(`${x},${y}`) && !visible.has(`${x},${y}`)) return writeLog('You know nothing about that square yet.');
  const npc = visible.has(`${x},${y}`) ? npcAt(x, y) : null;
  const item = visible.has(`${x},${y}`) ? itemAt(x, y) : null;
  if (item) return writeLog(itemDefinitions[item.type].description);
  const tile = tileAt(x, y);
  if (!npc && tile.readableText) showReadableOverlay(tile);
  writeLog(npc ? `${npc.profile.name}: ${npc.profile.description}` : tile.description);
}

function blocksView(x, y) {
  const tile = tileAt(x, y);
  return tile.blocksView ?? tile.blocks;
}

function tileAt(x, y) {
  return tileAtFor(state.currentMapKey, x, y);
}

function tileAtFor(mapKey, x, y) {
  const targetMap = maps?.[mapKey] ?? map;
  const override = state?.tileOverrides?.[mapKey]?.[positionKey(x, y)];
  const tileType = override ?? targetMap.grid[y]?.[x];
  const baseTile = terrain[tileType] ?? terrain[' '];
  const overrideTerrain = state?.terrainOverrides[tileType];
  const tile = overrideTerrain ? { ...baseTile, ...overrideTerrain } : baseTile;
  if (state?.barriers?.some((barrier) => barrier.mapKey === mapKey && barrier.x === x && barrier.y === y)) {
    return { ...tile, blocks: true, blocksView: false, description: 'A police barrier blocks the taped-off crime scene.' };
  }
  return tile;
}

function npcAt(x, y) {
  return state.npcs.find((npc) => npc.mapKey === state.currentMapKey && npc.x === x && npc.y === y);
}

function npcAtOnMap(mapKey, x, y) {
  return state.npcs.find((npc) => npc.mapKey === mapKey && npc.x === x && npc.y === y);
}

function carAt(x, y) {
  return carAtOnMap(state.currentMapKey, x, y);
}

function carAtOnMap(mapKey, x, y) {
  return state.cars.find((car) => car.mapKey === mapKey && car.x === x && car.y === y);
}

function itemAt(x, y) {
  return state.items.find((item) => {
    const definition = itemDefinitions[item.type];
    return definition?.collectible !== false
      && (item.mapKey ?? 'station') === state.currentMapKey
      && item.x === x
      && item.y === y;
  });
}

function pickUpItem(item) {
  const definition = itemDefinitions[item.type];
  if (definition.collectible === false) return null;
  state.items = state.items.filter((candidate) => candidate.id !== item.id);
  state.inventory.push({ id: item.id, type: item.type, name: definition.name, description: definition.description });
  renderInventory();
  return `You pick up ${definition.name}: ${definition.description}`;
}

function useInventoryItem(itemId) {
  const item = state.inventory.find((candidate) => candidate.id === itemId);
  if (!item) return;
  const definition = itemDefinitions[item.type];
  if (!definition.reusable) state.inventory = state.inventory.filter((candidate) => candidate.id !== itemId);
  renderInventory();
  definition.effect({ item });
}


function fireGun(dx, dy) {
  if (dx === undefined || dy === undefined) {
    state.shootingMode = true;
    writeLog('You raise the gun. Press a direction key to fire.');
    draw();
    return;
  }

  state.shootingMode = false;
  state.gunfirePanic = true;
  const shot = traceBullet(dx, dy);
  state.bullet = { path: shot.path, index: 0 };
  animateBullet(shot);
}

function traceBullet(dx, dy) {
  const path = [];
  let x = state.player.x + dx;
  let y = state.player.y + dy;
  while (!tileAtFor(state.currentMapKey, x, y).blocks) {
    path.push({ x, y });
    const npc = npcAt(x, y);
    if (npc) return { path, hitNpc: npc };
    x += dx;
    y += dy;
  }
  return { path };
}

function animateBullet(shot) {
  const step = () => {
    if (!state.bullet) return;
    if (state.bullet.index >= shot.path.length) {
      finishBullet(shot);
      return;
    }
    draw();
    state.bullet.index += 1;
    window.setTimeout(step, 35);
  };
  step();
}

function gunfireReactionSummary(excludedNpc = null) {
  const witnesses = state.npcs
    .filter((npc) => npc !== excludedNpc && npc.mapKey === state.currentMapKey)
    .slice(0, 4);
  const reactions = witnesses.map((npc) => `${npc.profile.name} ${npc.profile.gunfireReaction}`);
  if (!reactions.some((reaction) => reaction.includes('chase'))) reactions.push('Police give chase while civilians run for cover');
  return reactions.join('; ') + '.';
}

function finishBullet(shot) {
  state.bullet = null;
  if (!shot.hitNpc) {
    writeLog(`The gunshot cracks through the loop. ${gunfireReactionSummary()}`);
    draw();
    return;
  }

  state.npcs = state.npcs.filter((npc) => npc !== shot.hitNpc);
  leaveCorpse(shot.hitNpc);
  writeLog(`The bullet hits ${shot.hitNpc.profile.name}. A corpse falls to the ground. ${gunfireReactionSummary(shot.hitNpc)}`);
  draw();
}

function renderInventory() {
  inventoryList.replaceChildren();
  if (state.inventory.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-inventory';
    empty.textContent = 'Nothing yet. Walk over items to pick them up.';
    inventoryList.appendChild(empty);
    return;
  }

  state.inventory.forEach((item) => {
    const button = document.createElement('button');
    button.className = 'inventory-item';
    button.type = 'button';
    button.title = `${item.description} Click to use.`;
    button.addEventListener('click', () => useInventoryItem(item.id));

    const name = document.createElement('strong');
    name.textContent = item.name;
    const description = document.createElement('span');
    description.textContent = item.description;
    button.append(name, description);
    inventoryList.appendChild(button);
  });
}

function closeReadableOverlay() {
  if (readableOverlay.open) readableOverlay.close();
}

function showReadableOverlay(tile) {
  readableTitle.textContent = tile.readableTitle ?? 'Readable text';
  const lines = Array.isArray(tile.readableText) ? tile.readableText : [tile.readableText];
  readableText.replaceChildren(...lines.map((line) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    return paragraph;
  }));
  if (!readableOverlay.open) readableOverlay.show();
}

function writeLog(message) {
  const entry = document.createElement('p');
  const timestamp = document.createElement('time');
  timestamp.textContent = `[Loop ${loopCount}, minute ${elapsedMinutes()}]`;
  entry.append(timestamp, ` ${message}`);
  log.appendChild(entry);
  while (log.children.length > MAX_LOG_ENTRIES) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

function elapsedMinutes() {
  return state.loopLimit - state.minutesLeft;
}

function playResetEffect() {
  clearTimeout(resetEffectTimeout);
  loopEffect.classList.remove('active');
  void loopEffect.offsetWidth;
  loopEffect.classList.add('active');
  resetEffectTimeout = setTimeout(() => loopEffect.classList.remove('active'), RESET_EFFECT_MS);
}

function desaturate(color) {
  const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
  const gray = 0.3 * r + 0.59 * g + 0.11 * b;
  const mix = (channel) => Math.round(gray * 0.9 + channel * 0.1);
  return (mix(r) << 16) + (mix(g) << 8) + mix(b);
}
