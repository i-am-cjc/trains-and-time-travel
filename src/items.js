import { POCKET_WATCH_BONUS_MINUTES } from './constants.js';

export function createItemDefinitions({ addLoopMinutes, writeLog, draw }) {
  return {
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
];
