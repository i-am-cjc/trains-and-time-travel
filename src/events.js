export function createScheduledEvents({ updateTerrain, moveItem, writeLog, queueStationMasterDoorAction }) {
  return [
    {
      id: 'station-announcement',
      triggerMinute: 5,
      oncePerLoop: true,
      effect: () => {
        writeLog('The platform speakers crackle: “Five minutes gone. Please keep your belongings inside this timeline.”');
      },
    },
    {
      id: 'kiosk-bell',
      triggerMinute: 15,
      oncePerLoop: true,
      effect: () => {
        updateTerrain('K', {
          interact: 'The kiosk bell gives one bright ring, then the clock hand jumps backward.',
          description: 'A kiosk with a freshly ringing bell and a suspiciously confident clock.',
        });
        moveItem('pocket-watch', { x: 58, y: 15 });
        writeLog('A kiosk bell rings somewhere down the concourse. Something small skitters across the paving.');
      },
    },
    {
      id: 'shop-sign-change',
      triggerMinute: 30,
      oncePerLoop: true,
      effect: () => {
        updateTerrain('S', {
          interact: 'The shop sign now reads “BACK IN FIVE MINUTES,” but the five never shrinks.',
          description: 'A small shop with a hand-painted sign promising to return in five impossible minutes.',
        });
        writeLog('Every shop sign flips at once: “BACK IN FIVE MINUTES.”');
      },
    },
    {
      id: 'station-master-unlock-door',
      triggerMinute: 30,
      oncePerLoop: true,
      effect: () => {
        queueStationMasterDoorAction('open');
        writeLog('The station master checks the platform clock and starts toward the side-room door.');
      },
    },
    {
      id: 'station-master-lock-door',
      triggerMinute: 75,
      oncePerLoop: true,
      effect: () => {
        queueStationMasterDoorAction('close');
        writeLog('The station master turns back toward the side-room door with the brass key ready.');
      },
    },
    {
      id: 'train-final-warning',
      triggerMinute: ({ loopLimit }) => loopLimit - 10,
      oncePerLoop: true,
      effect: () => {
        updateTerrain('T', {
          description: 'The waiting train shudders with final-loop static. Boarding now will end this loop.',
        });
        writeLog('The train horn blares twice. Ten minutes remain before the loop collapses.');
      },
    },
  ];
}
