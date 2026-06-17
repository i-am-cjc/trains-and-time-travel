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

export const npcDefinitions = [
  {
    key: 'stationMaster',
    name: 'Station Master',
    description: 'The station master keeps one eye on the train and one hand on a heavy brass key.',
    dialogue: [
      'The station master says, “Rules are rules. That side room opens at half past and closes at minute seventy-five.”',
      'The station master pats a brass key. “If you hear me lock it, do not linger below.”',
      'The station master says, “Mind the stairs. They lead under more than the platform.”',
      'The station master says, “Off the tracks at once! Timetables are difficult enough without trespassers.”',
    ],
    blockedRemarks: [
      'The station master says, “Stand clear, please. I have a door to attend.”',
      'The station master rattles the keyring. “Official business.”',
    ],
    routePreference: 'station master timed door',
  },
  {
    key: 'commuter',
    name: 'Mara Vale',
    description: 'A commuter in a raincoat keeps checking the platform clock.',
    dialogue: [
      'Mara Vale says, “If I miss this train again, I am blaming the clock.”',
      'Mara Vale says, “The same two hours, the same platform, the same late meeting.”',
      'Mara Vale says, “Please let me through. The train doors never wait for me.”',
    ],
    blockedRemarks: [
      'Mara Vale says, “Sorry, that train is mine.”',
      'Mara Vale taps her ticket. “Platform, please.”',
    ],
    routePreference: 'commuter to train',
  },
  {
    key: 'shopkeeper',
    name: 'Oren Pike',
    description: 'A shopkeeper with ink-stained fingers counts coins on the way to the kiosk.',
    dialogue: [
      'Oren Pike says, “The kiosk clock loses a minute whenever nobody watches it.”',
      'Oren Pike says, “I keep restocking yesterday’s papers.”',
      'Oren Pike says, “If you see my delivery, send it toward the shop.”',
    ],
    blockedRemarks: [
      'Oren Pike says, “Mind the papers, please.”',
      'Oren Pike says, “I need to get back to the counter.”',
    ],
    routePreference: 'shopkeeper to kiosk',
  },
  {
    key: 'tourist',
    name: 'Elsie Rowan',
    description: 'A lost tourist circles the platform with an upside-down timetable.',
    dialogue: [
      'Elsie Rowan says, “Does this platform go to tomorrow, or only back to noon?”',
      'Elsie Rowan says, “I have asked for directions three times. The answers keep changing.”',
      'Elsie Rowan says, “I recognize that bench. I think it recognizes me too.”',
    ],
    blockedRemarks: [
      'Elsie Rowan says, “Oh! Is this the way to the platform?”',
      'Elsie Rowan studies her map. “I thought I had just passed here.”',
    ],
    routePreference: 'lost tourist pacing near platform',
  },
];

export const npcProfileAssignments = {
  // Optional map-coordinate overrides. Format: 'x,y': 'profileKey'.
  '64,8': 'shopkeeper',
  '34,15': 'commuter',
  '14,22': 'tourist',
};

export { npcBlockedRemarks };
