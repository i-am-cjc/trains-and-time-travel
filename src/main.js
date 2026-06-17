import { Application, Container, Graphics } from 'pixi.js';
import './styles.css';

const TILE_SIZE = 20;
const LOOP_MINUTES = 60;
const SIGHT_RADIUS = 8;
const MAP_URL = '/maps/station-loop.txt';

const terrain = {
  '#': { color: 0x38404d, blocks: true, description: 'A solid wall blocks the way.' },
  '.': { color: 0x656b72, blocks: false, description: 'Station paving.' },
  '=': { color: 0x20242a, blocks: true, description: 'The train line blocks the northern edge of town.' },
  'T': { color: 0x335f8f, blocks: false, train: true, description: 'The waiting train. Step back aboard to end this loop.' },
  'D': { color: 0x9b6a3c, blocks: false, description: 'An open doorway.' },
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
const inspectButton = document.querySelector('#inspect-button');
const inspectStatus = document.querySelector('#inspect-status');
let inspectMode = false;
let state;

await app.init({ background: '#000000', resizeTo: document.querySelector('#game'), antialias: false });
document.querySelector('#game').appendChild(app.canvas);
app.stage.addChild(world);

const map = await loadMap(MAP_URL);
resetLoop('The doors hiss open. You step onto the platform with one hour before everything resets.');

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

function resetLoop(message) {
  state = {
    player: { ...map.start },
    minutesLeft: LOOP_MINUTES,
    facing: [0, 1],
    seen: new Set(),
    npcs: map.npcs.map((npc) => ({ ...npc, phase: 0 })),
  };
  draw();
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
    if (cell === 'N') npcs.push({ x, y });
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
  spendMinute(tile.train ? 'You step back onto the train and deliberately end the loop.' : 'You move through the town.');
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
  if (state.minutesLeft <= 0) return resetLoop('The hour expires. Everything snaps back to the moment you arrived.');
  draw();
  writeLog(message);
}

function moveNpcs() {
  const pattern = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  state.npcs = state.npcs.map((npc) => {
    const [dx, dy] = pattern[npc.phase % pattern.length];
    const next = { x: npc.x + dx, y: npc.y + dy, phase: npc.phase + 1 };
    if (tileAt(next.x, next.y).blocks || (next.x === state.player.x && next.y === state.player.y)) {
      return { ...npc, phase: npc.phase + 1 };
    }
    return next;
  });
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
  state.npcs.forEach((npc) => drawSquare(npc.x, npc.y, 0xff8a65, visible.has(`${npc.x},${npc.y}`)));
  drawSquare(state.player.x, state.player.y, 0x61dafb, true);
  world.x = Math.round(app.screen.width / 2 - (state.player.x + 0.5) * TILE_SIZE);
  world.y = Math.round(app.screen.height / 2 - (state.player.y + 0.5) * TILE_SIZE);
  hud.textContent = `Minutes left: ${state.minutesLeft} / ${LOOP_MINUTES}`;
}

function drawTile(x, y, isVisible) {
  const remembered = state.seen.has(`${x},${y}`);
  if (!isVisible && !remembered) return drawSquare(x, y, 0x000000, true);
  drawSquare(x, y, tileAt(x, y).color, isVisible, remembered && !isVisible);
}

function drawSquare(x, y, color, visible, desaturated = false) {
  const g = new Graphics();
  const finalColor = desaturated ? desaturate(color) : color;
  g.rect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE - 1, TILE_SIZE - 1).fill(visible ? finalColor : 0x000000);
  world.addChild(g);
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
  if (!state.seen.has(`${x},${y}`) && !visibleTiles().has(`${x},${y}`)) return writeLog('You know nothing about that square yet.');
  const npc = npcAt(x, y);
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

function writeLog(message) {
  log.textContent = message;
}

function desaturate(color) {
  const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
  const gray = 0.3 * r + 0.59 * g + 0.11 * b;
  const mix = (channel) => Math.round(gray * 0.9 + channel * 0.1);
  return (mix(r) << 16) + (mix(g) << 8) + mix(b);
}
