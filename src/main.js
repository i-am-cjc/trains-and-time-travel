import { Application, Container, Graphics } from 'pixi.js';
import './styles.css';

const TILE_SIZE = 32;
const LOOP_MINUTES = 120;
const POCKET_WATCH_BONUS_MINUTES = 30;
const SIGHT_RADIUS = 100;
const MAP_URL = '/maps/station-loop.txt';
const RESET_EFFECT_MS = 900;
const MAX_LOG_ENTRIES = 80;

const npcBlockedRemarks = [
  'Excuse me.',
  'Move please.',
  'Out of the way, if you do not mind.',
  'Sorry, I need to get through.',
  'Could you let me pass?',
  'I am trying to catch the train.',
  'Pardon me, coming through.',
  'You are standing right where I need to be.',
  'Mind your step, please.',
  'Make way, please.',
];

const terrain = {
  '#': { color: 0x38404d, blocks: true, description: 'A solid wall blocks the way.' },
  '.': { color: 0x656b72, blocks: false, description: 'Station paving.' },
  '=': { color: 0x20242a, blocks: true, blocksView: false, description: 'The train line blocks the northern edge of town.' },
  'T': { color: 0x335f8f, blocks: false, blocksView: true, train: true, description: 'The waiting train. Step back aboard to end this loop.' },
  'D': { color: 0x9b6a3c, blocks: false, blocksView: true, description: 'An open doorway blocks your line of sight, but you can pass through.' },
  'W': { color: 0x4f6f8c, blocks: true, blocksView: false, description: 'A glass window blocks the way, but you can see through it.' },
  '~': { color: 0x317345, blocks: false, description: 'A patch of grass.' },
  'B': { color: 0x80613a, blocks: false, interact: 'You sit for a minute and watch the station repeat itself.', description: 'A station bench.' },
  'C': { color: 0x8d99ae, blocks: true, blocksView: false, description: 'A parked car.' },
  'S': { color: 0xc084fc, blocks: true, blocksView: false, interact: 'The shop window is full of headlines you swear you have already read.', description: 'A small shop.' },
  'K': { color: 0xf6c453, blocks: true, blocksView: false, interact: 'The kiosk clock ticks forward exactly one minute.', description: 'A kiosk.' },
  'N': { color: 0xff8a65, blocks: true, blocksView: false, npc: true, interact: 'They mutter about catching the same train again.', description: 'A townsperson.' },
  'P': { color: 0x656b72, blocks: false, start: true, description: 'Your starting point on the platform.' },
  ' ': { color: 0x111111, blocks: true, description: 'An unmapped void.' },
};

const directions = {
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};

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

const itemDefinitions = {
  pocketWatch: {
    name: 'Pocket watch',
    description: 'A brass watch wound against the loop. Use it to add 30 minutes to this loop.',
    color: 0xf6c453,
    effect: ({ item }) => {
      state.minutesLeft += POCKET_WATCH_BONUS_MINUTES;
      state.loopLimit += POCKET_WATCH_BONUS_MINUTES;
      writeLog(`${item.name} clicks open. The loop stretches by ${POCKET_WATCH_BONUS_MINUTES} minutes.`);
      draw();
    },
  },
};

const placedItems = [
  { id: 'pocket-watch', type: 'pocketWatch', x: 23, y: 27 },
];

await app.init({ background: '#000000', resizeTo: document.querySelector('#game'), antialias: false });
document.querySelector('#game').appendChild(app.canvas);
app.stage.addChild(world);

const map = await loadMap(MAP_URL);
resetLoop('The doors hiss open. You step onto the platform with two hours before everything resets.', { effect: false });

window.addEventListener('keydown', (event) => {
  if (inspectMode) return;
  if (event.code === 'Space' || event.code === 'KeyE') {
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
  inspectStatus.textContent = inspectMode ? 'Click any visible or remembered square for a description.' : 'Use arrow keys or WASD to move.';
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
  state = {
    player: { ...map.start },
    minutesLeft: LOOP_MINUTES,
    loopLimit: LOOP_MINUTES,
    inventory: [],
    items: placedItems.map((item) => ({ ...item })),
    facing: [0, 1],
    seen: new Set(),
    npcs: map.npcs.map(createNpcState),
  };
  if (effect) playResetEffect();
  draw();
  renderInventory();
  writeLog(message);
}

async function loadMap(url) {
  const text = await fetch(url).then((response) => response.text());
  const rows = text.split('\n').filter((line) => line && !line.startsWith(';'));
  const width = Math.max(...rows.map((row) => row.length));
  const grid = rows.map((row) => row.padEnd(width, '#').split(''));
  const npcs = [];
  let start = { x: 1, y: 1 };
  grid.forEach((row, y) => row.forEach((cell, x) => {
    if (cell === 'P') start = { x, y };
    if (cell === 'N') {
      npcs.push({ x, y });
      grid[y][x] = '.';
    }
  }));
  return { grid, height: grid.length, width, start, npcs };
}

function tryMove(dx, dy) {
  state.facing = [dx, dy];
  const target = { x: state.player.x + dx, y: state.player.y + dy };
  const occupant = npcAt(target.x, target.y);
  if (occupant) return spendMinute(terrain.N.interact);
  const tile = tileAt(target.x, target.y);
  if (tile.blocks) {
    writeLog(tile.description);
    return;
  }
  state.player = target;
  const item = itemAt(target.x, target.y);
  const pickupMessage = item ? pickUpItem(item) : null;
  spendMinute(pickupMessage ?? (tile.train ? 'You step back onto the train and deliberately end the loop.' : null));
  if (tile.train) resetLoop('The train pulls away, then arrives again. The loop begins from the platform.');
}

function interact() {
  const [dx, dy] = state.facing;
  const target = { x: state.player.x + dx, y: state.player.y + dy };
  const npc = npcAt(target.x, target.y);
  if (npc) return spendMinute(terrain.N.interact);
  const tile = tileAt(target.x, target.y);
  if (tile.interact) return spendMinute(tile.interact);
  writeLog(tile.description);
}

function spendMinute(message) {
  state.minutesLeft -= 1;
  moveNpcs();
  if (state.minutesLeft <= 0) return resetLoop('The two-hour loop expires. Everything snaps back to the moment you arrived.');
  draw();
  if (message) writeLog(message);
}

function moveNpcs() {
  const occupied = new Set(state.npcs.map((npc) => positionKey(npc.x, npc.y)));
  const remarks = [];

  state.npcs = state.npcs.map((npc) => {
    let traveler = npc;
    if (traveler.x === traveler.target.x && traveler.y === traveler.target.y) {
      traveler = chooseNextNpcTarget(traveler);
    }

    const step = nextStepToward(traveler, occupied);
    if (!step) return traveler;

    if (step.x === state.player.x && step.y === state.player.y) {
      remarks.push(randomItem(npcBlockedRemarks));
      return traveler;
    }

    const stepKey = positionKey(step.x, step.y);
    if (occupied.has(stepKey) || tileAt(step.x, step.y).blocks) return traveler;

    occupied.delete(positionKey(traveler.x, traveler.y));
    occupied.add(stepKey);
    return { ...traveler, x: step.x, y: step.y };
  });

  remarks.forEach((remark) => writeLog(remark));
}

function createNpcState(npc, index) {
  const route = createNpcRoute(npc, index);
  return { ...npc, route, target: route[1] };
}

function createNpcRoute(npc, index) {
  const trainStops = walkableTiles().filter((point) => tileAt(point.x, point.y).train);
  const shopStops = pointsAdjacentTo('S');
  const walkStops = walkableTiles().filter((point) => !tileAt(point.x, point.y).train);
  const start = { x: npc.x, y: npc.y };

  if (index % 3 === 0 && trainStops.length && shopStops.length) return [randomItem(trainStops), randomItem(shopStops)];
  if (index % 3 === 1 && trainStops.length) return [randomItem(walkStops), randomItem(trainStops)];
  return [start, randomItem(walkStops)];
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
      if (cameFrom.has(key) || tileAt(neighbor.x, neighbor.y).blocks) return;
      if (occupied.has(key) && key !== targetKey) return;
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

function pointsAdjacentTo(cellType) {
  const points = [];
  map.grid.forEach((row, y) => row.forEach((cell, x) => {
    if (cell !== cellType) return;
    neighborsOf({ x, y }).forEach((point) => {
      if (!tileAt(point.x, point.y).blocks) points.push(point);
    });
  }));
  return uniquePoints(points);
}

function walkableTiles() {
  const points = [];
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!tileAt(x, y).blocks) points.push({ x, y });
    }
  }
  return points;
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

function positionKey(x, y) {
  return `${x},${y}`;
}

function draw() {
  world.removeChildren();
  const visible = visibleTiles();
  visible.forEach((key) => state.seen.add(key));
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      drawTile(x, y, visible.has(`${x},${y}`));
    }
  }
  state.items.forEach((item) => {
    if (visible.has(`${item.x},${item.y}`)) drawItem(item, true);
  });
  state.npcs.forEach((npc) => {
    if (visible.has(`${npc.x},${npc.y}`)) drawSprite(npc.x, npc.y, 'N', true);
  });
  drawSprite(state.player.x, state.player.y, 'player', true);
  world.x = Math.round(app.screen.width / 2 - (state.player.x + 0.5) * TILE_SIZE);
  world.y = Math.round(app.screen.height / 2 - (state.player.y + 0.5) * TILE_SIZE);
  hud.textContent = `Loop ${loopCount} · Minute ${elapsedMinutes()} / ${state.loopLimit} · ${state.minutesLeft} min left`;
}

function drawItem(item, visible) {
  const definition = itemDefinitions[item.type];
  const g = new Graphics();
  const px = item.x * TILE_SIZE;
  const py = item.y * TILE_SIZE;
  if (!visible) return;
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
      g.roundRect(px + 4, py + 9, 24, 14, 4).fill(tone(0xa5adbb));
      g.rect(px + 10, py + 5, 12, 7).fill(tone(0x79d2ff));
      g.circle(px + 10, py + 24, 3).fill(tone(0x15181f));
      g.circle(px + 23, py + 24, 3).fill(tone(0x15181f));
      break;
    case 'S':
      g.rect(px + 5, py + 7, 22, 18).fill(tone(0xa855f7));
      g.rect(px + 7, py + 9, 18, 6).fill(tone(0xe8dcff));
      g.rect(px + 13, py + 17, 6, 8).fill(tone(0x5b2b82));
      break;
    case 'K':
      g.rect(px + 7, py + 8, 18, 18).fill(tone(0xf6c453));
      g.rect(px + 5, py + 5, 22, 5).fill(tone(0xd97706));
      g.circle(px + 16, py + 17, 5).fill(tone(0xfff5cc));
      g.moveTo(px + 16, py + 17).lineTo(px + 16, py + 13).lineTo(px + 19, py + 17).stroke({ color: tone(0x20242a), width: 1.5 });
      break;
    case 'N':
    case 'player':
      g.circle(px + 16, py + 9, 5).fill(tone(sprite === 'player' ? 0x61dafb : 0xffc0a8));
      g.roundRect(px + 10, py + 15, 12, 11, 3).fill(tone(sprite === 'player' ? 0x1d8fb8 : 0xff8a65));
      g.rect(px + 8, py + 26, 6, 4).fill(tone(0x20242a));
      g.rect(px + 18, py + 26, 6, 4).fill(tone(0x20242a));
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
  writeLog(npc ? terrain.N.description : tileAt(x, y).description);
}

function blocksView(x, y) {
  const tile = tileAt(x, y);
  return tile.blocksView ?? tile.blocks;
}

function tileAt(x, y) {
  return terrain[map.grid[y]?.[x]] ?? terrain[' '];
}

function npcAt(x, y) {
  return state.npcs.find((npc) => npc.x === x && npc.y === y);
}

function itemAt(x, y) {
  return state.items.find((item) => item.x === x && item.y === y);
}

function pickUpItem(item) {
  const definition = itemDefinitions[item.type];
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
