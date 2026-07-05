/**
 * MJGTCG Colyseus server entry. Run: `npm run server` (tsx).
 * Defines the "game" room; clients connect via colyseus.js and exchange
 * { action } -> { view } messages (see GameRoom).
 */
import colyseus from "colyseus";
import { GameRoom } from "./GameRoom.js";
const { Server } = colyseus;

const port = Number(process.env.PORT ?? 2567);
const gameServer = new Server();
gameServer.define("game", GameRoom);

gameServer
  .listen(port)
  .then(() => console.log(`MJGTCG Colyseus server listening on :${port}`))
  .catch((e: unknown) => {
    console.error("server failed to start:", e);
    process.exit(1);
  });
