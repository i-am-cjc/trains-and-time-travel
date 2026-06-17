# Game basis

This repository now contains a browser-based single-player game prototype built with PixiJS and Vite.

## Running locally

```sh
npm install
npm run dev
```

The game canvas is mounted by `index.html`, with the engine in `src/main.js`.

## Controls

- Move one square at a time with the arrow keys or WASD.
- Moving into a wall, car, shop counter, townsperson, or train line is blocked and does **not** spend time.
- Moving into an open square spends one minute.
- Bumping into a townsperson interacts with them and spends one minute.
- Press Space or E to interact with the square you are facing; successful interactions spend one minute.
- Returning to the train ends the current loop immediately.
- Click **Inspect a square**, then click a known square to read a description.

## Time loop

Each loop starts at 120 minutes. Every successful move or interaction spends one minute. At zero minutes, the player, townspeople, remembered tiles, and the world state reset to the map's initial state.

## Map editing

The main editable station map lives at `public/maps/station-loop.txt`, with the stair-linked underground room in `public/maps/underground-room.txt`. It is a plain text grid so non-programmers can reshape the station, car park, shops, and town without changing JavaScript.

Legend:

| Character | Meaning |
| --- | --- |
| `#` | Wall |
| `.` | Floor or path |
| `-` | Platform edge tile that runs beside the track |
| `=` | Train line; blocks the top of the map |
| `T` | Train tile; stepping on it ends the loop |
| `P` | Player start |
| `C` | Parked car |
| `S` | Shop |
| `N` | Townsperson |
| `M` | Station master NPC |
| `B` | Bench |
| `K` | Kiosk |
| `A` | Announcement board |
| `L` | Lamp |
| `V` | Vending machine |
| `G` | Luggage |
| `R` | Ticket barrier |
| `O` | Station clock |
| `~` | Grass |
| `D` | Doorway |
| `X` | Locked station side-room door |
| `U` | Stairs between maps |

The station master starts near the train, walks to unlock the side-room door at minute 30, and returns to lock it at minute 60. Lines beginning with `;` are comments. The loader pads short rows with walls, but keeping the map rectangular makes it easier to edit.

## Rendering rules

The renderer uses a simple line-of-sight check from the player. Unseen squares are black. Squares seen earlier in the current loop but currently outside line of sight are rendered with their saturation reduced to 10% and faded to 67% opacity.
