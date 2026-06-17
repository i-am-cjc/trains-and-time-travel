import { POCKET_WATCH_BONUS_MINUTES } from './constants.js';

export function createItemDefinitions({ addLoopMinutes, writeLog, draw }) {
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
  { id: 'pocket-watch', type: 'pocketWatch', mapKey: 'station', x: 23, y: 27 },
  { id: 'car-spawner-right', type: 'carSpawnerRight', mapKey: 'station', x: 0, y: 30, dx: 1 },
  { id: 'car-spawner-left', type: 'carSpawnerLeft', mapKey: 'station', x: 79, y: 31, dx: -1 },
];
