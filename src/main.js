import { Application, Container, Graphics } from 'pixi.js';
import { directions, LOOP_MINUTES, MAP_URLS, MAX_LOG_ENTRIES, RESET_EFFECT_MS, SIGHT_RADIUS, TILE_SIZE } from './constants.js';
import { createScheduledEvents } from './events.js';
import { createItemDefinitions, placedItems } from './items.js';
import { npcBlockedRemarks, npcDefinitions, npcProfileAssignments } from './npcs.js';
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
let inspectMode = false;
let state;
let loopCount = 0;
let resetEffectTimeout;
const bloodStains = new Set();
const CAR_SPAWN_MINUTES = 5;
const CAR_SPAWN_MAX_MINUTES = 15;

const itemDefinitions = createItemDefinitions({ addLoopMinutes, writeLog, draw });
const scheduledEvents = createScheduledEvents({ updateTerrain, moveItem, writeLog, queueStationMasterDoorAction });

await app.init({ background: '#000000', resizeTo: document.querySelector('#game'), antialias: false });
document.querySelector('#game').appendChild(app.canvas);
app.stage.addChild(world);

const maps = Object.fromEntries(await Promise.all(
  Object.entries(MAP_URLS).map(async ([key, url]) => [key, await loadMap(url, key)]),
));
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
    carSpawnTimers: createCarSpawnTimers(),
    stationMasterScolding: false,
  };
  state.npcs = maps.station.npcs.map(createNpcState);
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
  const npcs = [];
  const stairs = [];
  let start = { x: 1, y: 1 };
  grid.forEach((row, y) => row.forEach((cell, x) => {
    if (cell === 'P') start = { x, y };
    if (cell === 'U' || cell === '^' || cell === 'v' || cell === 'E' || cell === 'Q') stairs.push({ x, y, type: cell });
    if (cell === 'N' || cell === 'M') {
      npcs.push({ x, y, mapKey, profileKey: cell === 'M' ? 'stationMaster' : npcProfileAssignments[positionKey(x, y)] });
      grid[y][x] = '.';
    }
  }));

  grid.forEach((row, y) => row.forEach((cell, x) => {
    const tile = terrain[cell] ?? terrain[' '];
    if (!tile.blocks) walkable.push({ x, y });
    if (tile.train) trainTiles.push({ x, y });
    if (!adjacentByCellType[cell]) adjacentByCellType[cell] = [];
    adjacentByCellType[cell].push(...neighborsOf({ x, y }).filter((point) => {
      const neighbor = terrain[grid[point.y]?.[point.x]] ?? terrain[' '];
      return !neighbor.blocks;
    }));
  }));

  Object.entries(adjacentByCellType).forEach(([cellType, points]) => {
    adjacentByCellType[cellType] = uniquePoints(points);
  });

  return { key: mapKey, grid, height: grid.length, width, start, stairs, npcs, walkable, adjacentByCellType, trainTiles };
}

function tryMove(dx, dy) {
  state.facing = [dx, dy];
  const target = { x: state.player.x + dx, y: state.player.y + dy };
  const occupant = npcAt(target.x, target.y);
  if (occupant) return spendMinute(npcDialogue(occupant));
  if (carAt(target.x, target.y)) return killPlayer('You step into the road and a car hits you before the loop can blink.');
  const tile = tileAt(target.x, target.y);
  if (tile.blocks) {
    writeLog(tile.description);
    return;
  }
  state.player = target;
  if (tile.track) alertStationMasterToTrackTrespass();
  if (tile.stairs || tile.stairsUp || tile.stairsDown || tile.officeEntrance || tile.officeExit) useStairs(tile);
  const item = itemAt(target.x, target.y);
  const pickupMessage = item ? pickUpItem(item) : null;
  spendMinute(pickupMessage ?? (tile.train ? 'You step back onto the train and deliberately end the loop.' : null));
  if (tile.train) resetLoop('The train pulls away, then arrives again. The loop begins from the platform.');
}

function interact() {
  const [dx, dy] = state.facing;
  const target = { x: state.player.x + dx, y: state.player.y + dy };
  const npc = npcAt(target.x, target.y);
  if (npc) return spendMinute(npcDialogue(npc));
  const tile = tileAt(target.x, target.y);
  if (tile.interact) return spendMinute(tile.interact);
  writeLog(tile.description);
}

function spendMinute(message) {
  state.minutesLeft -= 1;
  runScheduledEvents();
  moveNpcs();
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
  state.cars = state.cars
    .map((car) => ({ ...car, x: car.x + car.dx }))
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

function killNpc(npc) {
  bloodStains.add(`${npc.mapKey}:${positionKey(npc.x, npc.y)}`);
  writeLog(`${npc.profile.name} is struck by a passing car and killed.`);
  if (npc.profile.key === 'stationMaster') {
    state.stationMasterScolding = false;
    writeLog('Without the station master, the brass-key door will not be tended this loop.');
  }
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

function killPlayer(message) {
  bloodStains.add(`station:${positionKey(state.player.x, state.player.y)}`);
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

function stationDoorTile() {
  return tileAtFor('station', 62, 8);
}

function openStationDoor() {
  if (!stationDoorTile().lockedDoor) return;
  setTileOverride('station', 62, 8, 'D');
  writeLog('The station master unlocks the side-room door with a bright brass click.');
}

function closeStationDoor() {
  if (stationDoorTile().lockedDoor) return;
  setTileOverride('station', 62, 8, 'X');
  writeLog('The station master locks the side-room door again.');
  if (isPlayerInsideStationSideRoom()) {
    writeLog('You hear the lock turn somewhere above. You are still inside the station side room.');
  }
}

function isPlayerInsideStationSideRoom() {
  if (state.currentMapKey === 'underground') return true;
  return state.currentMapKey === 'station'
    && state.player.x >= 64
    && state.player.x <= 73
    && state.player.y >= 7
    && state.player.y <= 11;
}

function useStairs(tile) {
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
  updateStationMasterScoldingTarget();
  const occupied = new Set(state.npcs.map((npc) => `${npc.mapKey}:${positionKey(npc.x, npc.y)}`));
  const remarks = [];

  state.npcs = state.npcs.map((npc) => {
    let traveler = npc;
    if (traveler.x === traveler.target.x && traveler.y === traveler.target.y) {
      traveler = chooseNextNpcTarget(traveler);
    }

    const step = nextStepToward(traveler, occupied);
    if (!step) return traveler;

    if (traveler.mapKey === state.currentMapKey && step.x === state.player.x && step.y === state.player.y) {
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
    const moved = { ...traveler, x: step.x, y: step.y };
    handleNpcArrival(moved);
    return moved;
  });

  remarks.forEach((remark) => writeLog(remark));
}

function handleNpcArrival(npc) {
  if (npc.profile.key !== 'stationMaster' || npc.x !== 61 || npc.y !== 8) return;
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
  master.target = { x: 61, y: 8 };
  if (master.x === 61 && master.y === 8) performStationMasterDoorActions(master);
}

function resumeStationMasterDuties(npc) {
  if (npc.pendingDoorActions?.length) return { ...npc, target: { x: 61, y: 8 }, preScoldTarget: null };
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
  npc.target = { x: 54, y: 8 };
}

function createNpcState(npc, index) {
  const profile = npcDefinitions.find((definition) => definition.key === npc.profileKey) ?? npcDefinitions[index % npcDefinitions.length];
  const route = createNpcRoute(npc, profile);
  return { ...npc, profile, route, target: route[1] ?? route[0], pendingDoorActions: [] };
}

function createNpcRoute(npc, profile) {
  const trainStops = maps[npc.mapKey].trainTiles;
  const shopStops = pointsAdjacentTo('S', npc.mapKey);
  const kioskStops = pointsAdjacentTo('K', npc.mapKey);
  const walkStops = walkableTiles(npc.mapKey).filter((point) => !tileAtFor(npc.mapKey, point.x, point.y).train);
  const platformStops = walkableTiles(npc.mapKey).filter((point) => nearbyTrain(point, 4, npc.mapKey));
  const start = { x: npc.x, y: npc.y };

  if (profile.routePreference === 'station master timed door') {
    return [start, { x: 54, y: 8 }];
  }

  if (profile.routePreference === 'commuter to train' && trainStops.length) {
    return [start, randomItem(trainStops)];
  }

  if (profile.routePreference === 'shopkeeper to kiosk') {
    const shopStop = closestPoint(start, shopStops) ?? start;
    const kioskStop = randomItem(kioskStops.length ? kioskStops : walkStops);
    return [shopStop, kioskStop];
  }

  if (profile.routePreference === 'lost tourist pacing near platform') {
    const pacingStops = uniquePoints([start, ...platformStops]);
    return [start, randomItem(pacingStops.length > 1 ? pacingStops.filter((point) => point.x !== start.x || point.y !== start.y) : walkStops)];
  }

  return [start, randomItem(walkStops)];
}


function npcDialogue(npc) {
  return randomItem(npc.profile.dialogue) ?? terrain.N.interact;
}

function npcBlockedRemark(npc) {
  return randomItem(npc.profile.blockedRemarks ?? npcBlockedRemarks) ?? randomItem(npcBlockedRemarks);
}

function nearbyTrain(point, distance, mapKey = state.currentMapKey) {
  for (let y = point.y - distance; y <= point.y + distance; y += 1) {
    for (let x = point.x - distance; x <= point.x + distance; x += 1) {
      if (tileAtFor(mapKey, x, y).train) return true;
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

function nextStepToward(npc, occupied) {
  const startKey = positionKey(npc.x, npc.y);
  const targetKey = positionKey(npc.target.x, npc.target.y);
  const queue = [{ x: npc.x, y: npc.y }];
  const cameFrom = new Map([[startKey, null]]);

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (positionKey(current.x, current.y) === targetKey) break;

    neighborsOf(current).forEach((neighbor) => {
      const key = positionKey(neighbor.x, neighbor.y);
      if (cameFrom.has(key) || tileAtFor(npc.mapKey, neighbor.x, neighbor.y).blocks) return;
      if (occupied.has(`${npc.mapKey}:${key}`) && key !== targetKey) return;
      cameFrom.set(key, current);
      queue.push(neighbor);
    });
  }

  if (!cameFrom.has(targetKey)) return null;
  let step = npc.target;
  let previous = cameFrom.get(targetKey);
  while (previous && positionKey(previous.x, previous.y) !== startKey) {
    step = previous;
    previous = cameFrom.get(positionKey(previous.x, previous.y));
  }
  return step;
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
  state.cars.filter((car) => car.mapKey === state.currentMapKey).forEach((car) => {
    if (visible.has(`${car.x},${car.y}`)) drawSprite(car.x, car.y, car.sprite, true);
  });
  state.npcs.filter((npc) => npc.mapKey === state.currentMapKey).forEach((npc) => {
    if (visible.has(`${npc.x},${npc.y}`)) drawSprite(npc.x, npc.y, npc.profile.key === 'stationMaster' ? 'M' : 'N', true);
  });
  drawSprite(state.player.x, state.player.y, 'player', true);
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
  drawSprite(x, y, map.grid[y][x], true, rememberedOnly, rememberedOnly ? 0.67 : 1);
  if (bloodStains.has(`${state.currentMapKey}:${positionKey(x, y)}`)) drawSprite(x, y, 'blood', true, rememberedOnly, rememberedOnly ? 0.67 : 1);
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
      g.roundRect(px + inset, py + 4, TILE_SIZE - inset * 2, TILE_SIZE - 8, 4).fill(tone(0x335f8f));
      g.rect(px + 8, py + 8, 16, 8).fill(tone(0x9bd7ff));
      g.rect(px + 15, py + 18, 2, 10).fill(tone(0xf6c453));
      break;
    case 'D':
      g.rect(px + 6, py + 4, 20, 24).fill(tone(0x6f4724));
      g.circle(px + 21, py + 16, 2).fill(tone(0xf6c453));
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
      g.roundRect(px + 4, py + 9, 24, 14, 4).fill(tone(sprite === 'C' ? 0xa5adbb : 0xef4444));
      g.rect(px + 10, py + 5, 12, 7).fill(tone(0x79d2ff));
      g.circle(px + 10, py + 24, 3).fill(tone(0x15181f));
      g.circle(px + 23, py + 24, 3).fill(tone(0x15181f));
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
    case 'N':
    case 'M':
    case 'player':
      g.circle(px + 16, py + 9, 5).fill(tone(sprite === 'player' ? 0x61dafb : (sprite === 'M' ? 0xbfdbfe : 0xffc0a8)));
      g.roundRect(px + 10, py + 15, 12, 11, 3).fill(tone(sprite === 'player' ? 0x1d8fb8 : (sprite === 'M' ? 0x2563eb : 0xff8a65)));
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

function baseColorFor(sprite) {
  if (sprite === 'unknown') return 0x000000;
  if (sprite === 'player') return 0x264757;
  if (sprite === 'blood') return 0x000000;
  if (sprite === 'carLeft' || sprite === 'carRight') return 0x1f2933;
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
  writeLog(npc ? `${npc.profile.name}: ${npc.profile.description}` : tileAt(x, y).description);
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
  return overrideTerrain ? { ...baseTile, ...overrideTerrain } : baseTile;
}

function npcAt(x, y) {
  return state.npcs.find((npc) => npc.mapKey === state.currentMapKey && npc.x === x && npc.y === y);
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
  state.inventory = state.inventory.filter((candidate) => candidate.id !== itemId);
  renderInventory();
  itemDefinitions[item.type].effect({ item });
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
