/**
 * MJGTCG Colyseus server entry. Run: `npm run server` (tsx).
 * Defines the "game" room; clients connect via colyseus.js and exchange
 * { action } -> { view } messages (see GameRoom).
 */
import colyseus from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { createServer } from "node:http";
import { GameRoom } from "./GameRoom.js";
const { Server } = colyseus;

const port = Number(process.env.PORT ?? 2567);

// A plain HTTP health endpoint. Colyseus only answers its own /matchmake routes,
// so a bare `GET /` (what Fly/Railway/etc. health checks hit) otherwise hangs and
// the platform reports the app as unreachable. attachMatchMakingRoutes keeps this
// request listener as the fallback for non-matchmake paths, so matchmaking and the
// WebSocket upgrades keep working unchanged.
const httpServer = createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("MJGTCG server ok");
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  }
});

const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
gameServer.define("game", GameRoom);

gameServer
  .listen(port)
  .then(() => console.log(`MJGTCG Colyseus server listening on :${port}`))
  .catch((e: unknown) => {
    console.error("server failed to start:", e);
    process.exit(1);
  });
