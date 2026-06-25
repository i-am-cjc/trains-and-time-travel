export const TILE_SIZE = 32;
export const SIGHT_RADIUS = 100;
export const RESET_EFFECT_MS = 900;
export const MAX_LOG_ENTRIES = 80;

export const MAP_URLS = {
  station: '/maps/station-loop.txt',
  underground: '/maps/underground-room.txt',
  officeReception: '/maps/office-reception.txt',
  officeFloor1: '/maps/office-floor-1.txt',
  officeFloor2: '/maps/office-floor-2.txt',
  officeFloor3: '/maps/office-floor-3.txt',
  officeFloor4: '/maps/office-floor-4.txt',
  policeStation: '/maps/police-station.txt',
};

export const directions = {
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};
