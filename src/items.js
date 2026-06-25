export function createItemDefinitions({ resetRun, fireGun, igniteFire, writeLog, draw }) {
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
    lighter: {
      name: 'Lighter',
      description: 'A battered petrol lighter. Use it to ignite the tile in front of you; flames spread to one random nearby tile every 2-4 moves but cannot burn buildings.',
      color: 0xf97316,
      reusable: true,
      effect: () => {
        igniteFire();
      },
    },
    stopwatch: {
      name: 'Stopwatch',
      description: 'A brass stopwatch keyed to the station. Use it to manually reset the current run.',
      color: 0xf6c453,
      reusable: true,
      effect: ({ item }) => {
        resetRun(`${item.name} snaps shut. The station resets and a new run begins.`);
        draw();
      },
    },
  };
}

export const placedItems = [
  { id: 'stopwatch', type: 'stopwatch', mapKey: 'station', x: 55, y: 27 },
  { id: 'test-lighter', type: 'lighter', mapKey: 'station', x: 71, y: 12 },
  { id: 'hidden-gun', type: 'gun', mapKey: 'underground', x: 8, y: 5 },
  { id: 'car-spawner-right', type: 'carSpawnerRight', mapKey: 'station', x: 0, y: 30, dx: 1 },
  { id: 'car-spawner-left', type: 'carSpawnerLeft', mapKey: 'station', x: 143, y: 31, dx: -1 },
];
