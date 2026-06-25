import { POCKET_WATCH_BONUS_MINUTES } from './constants.js';

export function createItemDefinitions({ addLoopMinutes, fireGun, writeLog, draw }) {
  return {
    carSpawnerLeft: {
      name: 'Left-moving car spawner',
      description: 'A hidden traffic source blended into the road.',
      color: 0x1f2933,
      collectible: false,
    },
    carSpawnerRight: {
      name: 'Right-moving car spawner',
      description: 'A hidden traffic source blended into the road.',
      color: 0x1f2933,
      collectible: false,
    },
    gun: {
      name: 'Hidden gun',
      description: 'A small revolver wrapped in oilcloth. Use it to choose a direction and fire one shot.',
      color: 0x64748b,
      reusable: true,
      effect: ({ item }) => {
        fireGun(item);
      },
    },
    pocketWatch: {
      name: 'Pocket watch',
      description: 'A brass watch wound against the loop. Use it to add 30 minutes to this loop.',
      color: 0xf6c453,
      effect: ({ item }) => {
        addLoopMinutes(POCKET_WATCH_BONUS_MINUTES);
        writeLog(`${item.name} clicks open. The loop stretches by ${POCKET_WATCH_BONUS_MINUTES} minutes.`);
        draw();
      },
    },
  };
}

export const placedItems = [
  { id: 'pocket-watch', type: 'pocketWatch', mapKey: 'station', x: 55, y: 27 },
  { id: 'hidden-gun', type: 'gun', mapKey: 'underground', x: 8, y: 5 },
  { id: 'car-spawner-right', type: 'carSpawnerRight', mapKey: 'station', x: 0, y: 30, dx: 1 },
  { id: 'car-spawner-left', type: 'carSpawnerLeft', mapKey: 'station', x: 143, y: 31, dx: -1 },
];
