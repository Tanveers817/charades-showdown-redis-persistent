# Charades Showdown

A real-time, room-code party game for 2–8 players. Built with React, Vite, Node.js and Socket.IO.

## Current implementation

- Create a room with a six-character code; join from another device/browser.
- Lobby, ready state, host-only start, 2–8 player limit.
- Two turns per player; every player performs in join order.
- Random Act or Draw mode, 60-second server-authoritative turn timer.
- Private prompt sent only to the performer.
- Live drawing relay, guesses, server-side scoring and leaderboard.
- Up to two passes per turn; mixed word difficulty.
- Host handoff and disconnected-player seat retention during a game.
- Responsive interface for phone, tablet and desktop.
- Health endpoint at `/health`.
- Persistent Socket.IO client connection with automatic reconnect/backoff.
- Optional Redis Pub/Sub adapter for broadcasting Socket.IO events across server instances.
- Redis TTL cache of public room snapshots (6-hour expiry).

## Important scope notes

This is a runnable starter implementation, not a deployed public service. Room state is held in server memory and is lost if the server restarts. Production hosting should add a shared Socket.IO adapter (for multiple server instances), persistent room/session storage, rate limiting, origin allowlists, TLS, abuse controls, observability, and a privacy-reviewed word/content pack.

The game uses a shared room screen for the drawing surface. In Act mode, the performer acts in person or on camera; this app does not stream video/audio.

## Requirements

- Node.js 20+
- npm
- Optional: k6 for the load-test script

## Run locally

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal (normally http://localhost:5173). Open it in separate browser windows/devices. One player creates a room; others join using the displayed code.

For a production-style local build:

```bash
npm run build
npm start
```

Then open http://localhost:3001. The Express server serves the health endpoint; configure a static web host or add static-file serving for the Vite `dist` folder before single-origin production deployment.

## Tests

```bash
npm test
```

The Node test suite covers answer normalization, room-code shape, difficulty selection, scoring, and game configuration.

Optional socket connection load test (requires k6):

```bash
k6 run tests/load/rooms.js
```

Override load:

```bash
VUS=100 DURATION=60s WS_URL=ws://localhost:3001/socket.io/?EIO=4\\&transport=websocket k6 run tests/load/rooms.js
```

This is a connection smoke/load test, not a full end-to-end game simulation. For release qualification, add browser automation (e.g. Playwright) to exercise two-device room creation/join, readiness, turn rotation, guesses, drawing, reconnection, and final scoring.

## Performance and reliability decisions

- Socket.IO WebSocket transport preferred, polling fallback retained.
- Compact event payloads; draw relay is volatile so stale strokes do not queue behind network congestion.
- Drawing points normalized to 0–1 and capped at 80 points per event.
- Client countdown derives from server `endsAt`, avoiding timer drift.
- Score calculation and answer validation happen on the server.
- Duplicate correct guesses are rejected by the server.
- React handlers are stable where useful; leaderboard sorting is memoized.
- Canvas uses device pixel ratio capped at 2.
- Health endpoint supports deployment checks.

## Known limitations to address before public launch

- Add room expiry and idle-room cleanup.
- Add rate limits and input abuse protection for guesses and room creation.
- Add persistent identity/rejoin tokens; current reconnect behavior is limited because socket IDs change.
- Add robust host migration during an active game.
- Add round/turn index display polish and clear-drawing state synchronization for late joiners.
- Add full integration and browser performance tests, plus measured latency/CPU/memory baselines under target hosting.
- Add deployment configuration, TLS, environment-based CORS allowlist and monitoring.


## Redis and persistent connections (v1.1)

1. Copy `.env.example` to `.env` and set `REDIS_URL`.
2. Start Redis locally or provision a managed Redis service.
3. Install dependencies and start the app:

```bash
npm install
npm run dev
```

When `REDIS_URL` is present, the server enables the Socket.IO Redis adapter for cross-instance event broadcasting and caches public room snapshots under `charades:room:<CODE>` with a six-hour TTL. Without Redis, local development continues in in-memory mode.

The browser keeps a persistent Socket.IO connection while the page is open and automatically retries after transient disconnects using exponential backoff.

**Important production limitation:** this version does not yet restore an in-progress game from Redis after a Node.js process restart, nor does it support safe shared game-state mutation across multiple Node.js instances. The Redis adapter distributes Socket.IO events, but it does not make the in-memory `rooms` Map distributed. For multi-instance production, move authoritative room state, turn deadlines, idempotency keys, and reconnect/player identity tokens into Redis (or a transactional database), and use a single-writer/atomic transition strategy. Sticky sessions are also required if HTTP long-polling is enabled behind a load balancer; alternatively force WebSocket-only where the network permits it.
