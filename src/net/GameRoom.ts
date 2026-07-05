/**
 * MJGTCG Colyseus room — thin authoritative wrapper over GameSession.
 *
 * State sync is message-based (not @colyseus/schema): each client receives its
 * own REDACTED ClientView ("view" message) so hidden info never leaves the
 * server. Clients send { type:"action", ... } reducer actions; the room
 * authorizes by seat via GameSession and re-broadcasts views.
 */
import colyseus from "colyseus";
import type { Client } from "colyseus";
import { readFileSync } from "node:fs";
const { Room } = colyseus;
import "../engine/index.js"; // side-effect: wires resolver/collector/aura/restriction providers
import * as M from "../engine/reducer.js";
import type { Ability } from "../engine/rules.js";
import { GameSession, type Command, type Response, type ChainToggle, type Choice, type FreeAction, BoardAction } from "./session.js";
import { ManualSession, type ManualAction } from "./manual.js";
import { buildDecks, type ManifestEntry } from "../decks.js";

const baseSet = JSON.parse(
  readFileSync(new URL("../../base_set.json", import.meta.url), "utf-8"),
) as M.Card[];
// Parsed PSCT abilities -> the rules registry, so flags like once_per_turn /
// at_any_time are actually enforced (keyed `${cardId}:${role}`).
type ParsedCard = { id: string; abilities: { role: string; type?: string; parsed?: unknown }[] };
const ABILITY_REGISTRY: Record<string, Ability> = {};
for (const c of JSON.parse(readFileSync(new URL("../../base_set_parsed.json", import.meta.url), "utf-8")) as ParsedCard[]) {
  for (const a of c.abilities ?? []) {
    ABILITY_REGISTRY[`${c.id}:${a.role}`] = { type: a.type, parsed: a.parsed } as Ability;
  }
}
const manifest = JSON.parse(
  readFileSync(new URL("../../manifest.json", import.meta.url), "utf-8"),
) as Record<string, ManifestEntry>;
// decks are built PER GAME (Main-card multiplicity scales with player count — see decks.ts)
function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j]!, r[i]!];
  }
  return r;
}
const SPECTATOR = -1; // a seat that matches no player -> redactFor hides every hand
/** A safe display nickname: trimmed, 20 chars max, falling back to "Anon". */
function sanitizeName(n: unknown): string {
  const s = (typeof n === "string" ? n : "").replace(/\s+/g, " ").trim().slice(0, 20);
  return s || "Anon";
}

export type GameMode = "auto" | "manual";
export interface LobbyState {
  code: string; // 5-digit room code (share to invite)
  players: number; // target player count to start
  joined: number; // seats currently filled
  seats: number[]; // occupied seat ids
  host: number; // host seat (lowest occupied); always-ready, can start/kick
  ready: number[]; // non-host seats that have readied up
  isPrivate: boolean;
  started: boolean;
  mode: GameMode; // "auto" = rules-enforced; "manual" = free-form sandbox
  cheats: boolean; // dev tool + Free mode available in this room
  league: boolean; // "League" expansion added to the Main deck (manual mode only)
  names: Record<number, string>; // seat -> chosen nickname
}
/** Room metadata exposed via getAvailableRooms (drives the public browser). */
export interface RoomMeta {
  code: string;
  players: number;
  joined: number;
  isPrivate: boolean;
  started: boolean;
  mode: GameMode;
  cheats: boolean;
  league: boolean;
  names: Record<number, string>;
}

export class GameRoom extends Room {
  override maxClients = 8; // up to 4 players + spectators
  private session: GameSession | null = null;
  private manual: ManualSession | null = null; // free-form sandbox (mode === "manual")
  private mode: GameMode = "auto";
  private cheats = false; // dev tool + Free mode allowed (room option)
  private league = false; // "League" expansion in the Main deck (manual mode only)
  private seatByClient = new Map<string, number>();
  private targetPlayers = 2; // chosen by whoever creates the room (2–4)
  private isPrivate = false;
  private code = "";
  private ready = new Set<number>(); // non-host seats that have readied up
  private chat: { seat: number; name: string; text: string }[] = []; // room chat (players + spectators)
  private nameByClient = new Map<string, string>(); // sessionId -> nickname (players AND spectators)
  private lastBugAt = new Map<string, number>(); // sessionId -> last bug-report time (anti-spam)

  override onCreate(options: { players?: number; isPrivate?: boolean; mode?: GameMode; cheats?: boolean; league?: boolean }): void {
    this.targetPlayers = Math.max(2, Math.min(4, Math.floor(options?.players ?? 2)));
    this.isPrivate = !!options?.isPrivate;
    this.mode = options?.mode === "manual" ? "manual" : "auto";
    this.cheats = !!options?.cheats;
    // the League expansion is unimplemented (no rules) — manual mode only
    this.league = !!options?.league && this.mode === "manual";
    this.code = String(Math.floor(10000 + Math.random() * 90000)); // random 5-digit
    this.refreshMeta();
    // The game session is created once enough players have joined (startGame()).
    const requireSeat = (client: Client): number | undefined => {
      const seat = this.seatByClient.get(client.sessionId);
      if (seat === undefined) client.send("error", "spectators cannot act");
      return seat;
    };
    const requireGame = (client: Client): GameSession | undefined => {
      if (!this.session) { client.send("error", "game has not started yet"); return undefined; }
      return this.session;
    };
    // MANUAL mode: a free-form action from any seated player, any time (no turns/rules).
    this.onMessage("manual", (client: Client, a: ManualAction) => {
      if (!this.manual) { client.send("error", "not a manual game"); return; }
      const seat = requireSeat(client);
      if (seat === undefined) return;
      const res = this.manual.apply(seat, a);
      if (!res.ok) client.send("error", res.error ?? "illegal");
      this.pushViews();
    });
    // high-level turn command (draw / endTurn / advance / discard / summon / activate)
    this.onMessage("command", (client: Client, cmd: Command) => {
      const game = requireGame(client); if (!game) return;
      const seat = requireSeat(client);
      if (seat === undefined) return;
      const res = game.command(seat, cmd);
      if (!res.ok) client.send("error", res.error);
      this.pushViews();
    });
    // response to an open window (activate an At-any-time effect, or pass)
    this.onMessage("respond", (client: Client, r: Response) => {
      const game = requireGame(client); if (!game) return;
      const seat = requireSeat(client);
      if (seat === undefined) return;
      const res = game.respond(seat, r);
      if (!res.ok) client.send("error", res.error);
      this.pushViews();
    });
    // answer an optional-trigger prompt (use it? which target?)
    this.onMessage("choose", (client: Client, c: Choice) => {
      const game = requireGame(client); if (!game) return;
      const seat = requireSeat(client);
      if (seat === undefined) return;
      const res = game.choose(seat, c);
      if (!res.ok) client.send("error", res.error);
      this.pushViews();
    });
    // per-seat chain toggle (off / auto)
    this.onMessage("toggle", (client: Client, t: ChainToggle) => {
      const game = requireGame(client); if (!game) return;
      const seat = requireSeat(client);
      if (seat === undefined) return;
      game.setToggle(seat, t);
      this.sendView(client);
    });
    // DEV/sandbox: Free mode — direct zone manipulation on the auto board
    this.onMessage("free", (client: Client, a: FreeAction) => {
      if (!this.cheats) { client.send("error", "cheats are disabled in this room"); return; }
      const game = requireGame(client); if (!game) return;
      const seat = requireSeat(client);
      if (seat === undefined) return;
      const res = game.free(seat, a);
      if (!res.ok) client.send("error", res.error);
      this.pushViews();
    });
    // free-position board arrangement: drag own cards / browse or add own pages
    this.onMessage("board", (client: Client, a: BoardAction) => {
      const game = requireGame(client); if (!game) return;
      const seat = requireSeat(client);
      if (seat === undefined) return;
      const res = game.board(seat, a);
      if (!res.ok) client.send("error", res.error);
      this.pushViews();
    });
    // DEV/testing: drop any card into your own hand (regardless of phase/turn)
    this.onMessage("devSpawn", (client: Client, cardId: string) => {
      if (!this.cheats) { client.send("error", "cheats are disabled in this room"); return; }
      const game = requireGame(client); if (!game) return;
      const seat = requireSeat(client);
      if (seat === undefined) return;
      const res = game.devSpawn(seat, cardId);
      if (!res.ok) client.send("error", res.error);
      this.pushViews();
    });
    // lobby: toggle own ready (non-host seated players only)
    this.onMessage("ready", (client: Client) => {
      if (this.isRunning()) return;
      const seat = this.seatByClient.get(client.sessionId);
      if (seat === undefined || seat === this.host()) return;
      if (this.ready.has(seat)) this.ready.delete(seat); else this.ready.add(seat);
      this.broadcastState();
    });
    // lobby: host starts the game once the room is full and everyone is ready
    this.onMessage("start", (client: Client) => {
      if (this.isRunning()) return;
      const seat = this.seatByClient.get(client.sessionId);
      if (seat !== this.host()) { client.send("error", "only the host can start"); return; }
      if (!this.allReady()) { client.send("error", "need at least 2 players, all readied up"); return; }
      this.startGame();
    });
    // lobby: host kicks a seated player (anti-griefing)
    this.onMessage("kick", (client: Client, seat: number) => {
      if (this.isRunning()) return;
      if (this.seatByClient.get(client.sessionId) !== this.host()) return;
      if (seat === this.host()) return; // host can't kick the host
      for (const [sid, st] of this.seatByClient) {
        if (st === seat) {
          const target = this.clients.find((c) => c.sessionId === sid);
          if (target) { target.send("kicked"); void target.leave(); } // onLeave frees the seat + rebroadcasts
          break;
        }
      }
    });
    // room chat: any client (player or spectator) posts; broadcast to everyone.
    this.onMessage("chat", (client: Client, text: unknown) => {
      if (typeof text !== "string") return;
      const msg = text.trim().slice(0, 300);
      if (!msg) return;
      const seat = this.seatByClient.get(client.sessionId) ?? SPECTATOR;
      const name = this.nameByClient.get(client.sessionId) ?? "Anon";
      this.chat.push({ seat, name, text: msg });
      if (this.chat.length > 200) this.chat = this.chat.slice(-200); // cap history
      this.broadcast("chat", { seat, name, text: msg });
    });
    // bug report: any client (player or spectator) sends free text; the server
    // attaches context and forwards it to the Discord webhook (if configured).
    this.onMessage("bugReport", (client: Client, text: unknown) => {
      if (typeof text !== "string") return;
      const msg = text.trim().slice(0, 1800); // Discord content cap is 2000; leave room for the context line
      if (!msg) return;
      const now = Date.now();
      const last = this.lastBugAt.get(client.sessionId) ?? 0;
      if (now - last < 15000) { client.send("bugAck", { ok: false, reason: "please wait a few seconds between reports" }); return; }
      this.lastBugAt.set(client.sessionId, now);
      const seat = this.seatByClient.get(client.sessionId) ?? SPECTATOR;
      const name = this.nameByClient.get(client.sessionId) ?? "Anon";
      void this.forwardBugReport({ code: this.code, roomId: this.roomId, seat, name, text: msg });
      client.send("bugAck", { ok: true });
    });
    // clients request their current state after registering handlers (avoids a
    // join-time race where the first push arrives before listeners exist)
    this.onMessage("sync", (client: Client) => this.sendState(client));
    // Tolerate unknown message types. Colyseus otherwise disconnects the client
    // with WS_CLOSE_WITH_ERROR on an unregistered type (production mode), so a
    // client newer than the server — e.g. mid-deploy, when the client host
    // (Cloudflare) updates before the server host (Fly) — would be dropped mid-game.
    // Registering a catch-all makes the server ignore what it doesn't understand.
    this.onMessage("*", (_client: Client, type: string | number) => {
      console.warn(`[room ${this.roomId}] ignoring unknown message type: ${String(type)}`);
    });
  }

  /** POST a bug report to the Discord webhook in DISCORD_BUG_WEBHOOK. When the env
   *  var is unset (e.g. local dev) the report is just logged, so nothing crashes. */
  private async forwardBugReport(r: { code: string; roomId: string; seat: number; name: string; text: string }): Promise<void> {
    const who = r.seat === SPECTATOR ? "spectator" : `P${r.seat}`;
    const header = `🐛 **Bug report** — room \`${r.code}\` (${r.roomId}) · ${r.name} [${who}]`;
    const content = `${header}\n${r.text}`.slice(0, 2000);
    const url = process.env.DISCORD_BUG_WEBHOOK;
    if (!url) { console.log(`[bug report] (DISCORD_BUG_WEBHOOK not set)\n${content}`); return; }
    try {
      // allowed_mentions parse:[] neutralises any @everyone/@here in the free text
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      });
      if (!res.ok) console.error(`[bug report] webhook POST failed: ${res.status} ${res.statusText}`);
    } catch (e) {
      console.error("[bug report] webhook error:", e);
    }
  }

  /** Host = lowest occupied seat (the creator, or the next seat if they leave). */
  private host(): number {
    const seats = [...this.seatByClient.values()];
    return seats.length ? Math.min(...seats) : 0;
  }
  /** At least 2 players seated and every non-host seated player has readied. The
   *  host may start without filling the room (a 4-max room can start as 2/3). */
  private allReady(): boolean {
    if (this.seatByClient.size < 2) return false;
    const host = this.host();
    for (const s of this.seatByClient.values()) if (s !== host && !this.ready.has(s)) return false;
    return true;
  }

  override onJoin(client: Client, options?: { nickname?: string }): void {
    if (!this.isRunning()) {
      // lobby phase: hand out the next free seat (or spectator if full)
      const taken = new Set(this.seatByClient.values());
      let seat: number | undefined;
      for (let i = 0; i < this.targetPlayers; i++) if (!taken.has(i)) { seat = i; break; }
      if (seat !== undefined) this.seatByClient.set(client.sessionId, seat);
      this.nameByClient.set(client.sessionId, sanitizeName(options?.nickname));
      client.send("seat", seat ?? SPECTATOR);
      client.send("chatHistory", this.chat);
      this.refreshMeta();
      this.broadcastState(); // no auto-start: the host starts manually
    } else {
      // game already running -> spectator
      this.nameByClient.set(client.sessionId, sanitizeName(options?.nickname));
      client.send("seat", SPECTATOR);
      client.send("chatHistory", this.chat);
      this.sendState(client);
    }
  }

  override onLeave(client: Client): void {
    const seat = this.seatByClient.get(client.sessionId);
    this.seatByClient.delete(client.sessionId);
    if (seat !== undefined) this.ready.delete(seat);
    this.nameByClient.delete(client.sessionId);
    this.refreshMeta();
    if (!this.isRunning()) this.broadcastState(); // keep the lobby roster fresh
  }

  /** Is a game (auto or manual) running (vs still in the lobby)? */
  private isRunning(): boolean {
    return this.session !== null || this.manual !== null;
  }

  private startGame(): void {
    // start with the players actually seated now (may be fewer than the room's max)
    const seats = [...this.seatByClient.values()];
    // 3+ players use 2 copies of each Main card (Brick/Mooncakes stay at 1, LOB-001 at 3);
    // the League expansion (manual only) adds its cards, one copy each
    const DECKS = buildDecks(manifest, seats.length, { league: this.league });
    if (this.mode === "manual") {
      this.manual = ManualSession.create({ seats: shuffle(seats), main: DECKS.main, faith: DECKS.faith, startingHand: 5 });
      this.refreshMeta();
      this.broadcastState();
      return;
    }
    this.session = new GameSession(
      M.newGame({
        // randomised seating/turn order: players[0] goes first, then anticlockwise
        players: shuffle(seats),
        mainDeck: shuffle(DECKS.main),
        faithDeck: shuffle(DECKS.faith),
        startingHand: 5,
        cardRegistry: baseSet,
        registry: ABILITY_REGISTRY,
        seed: (Math.random() * 0x100000000) >>> 0, // PRNG seed for in-effect randomness
      }),
    );
    // default every seat's chain toggle to "auto" (prompt on opponent actions)
    for (const s of seats) this.session.setToggle(s, "auto");
    this.session.begin(); // open the starting-hands window, then settle to the first draw
    this.refreshMeta();
    this.broadcastState();
  }

  /** Publish room state to the matchmaker (drives the public room browser). */
  private refreshMeta(): void {
    const meta: RoomMeta = {
      code: this.code,
      players: this.targetPlayers,
      joined: this.seatByClient.size,
      isPrivate: this.isPrivate,
      started: this.isRunning(),
      mode: this.mode,
      cheats: this.cheats,
      league: this.league,
      names: this.namesObj(),
    };
    void this.setMetadata(meta);
  }

  private lobbyState(): LobbyState {
    return {
      code: this.code,
      players: this.targetPlayers,
      joined: this.seatByClient.size,
      seats: [...this.seatByClient.values()].sort((a, b) => a - b),
      host: this.host(),
      ready: [...this.ready],
      isPrivate: this.isPrivate,
      started: this.isRunning(),
      mode: this.mode,
      cheats: this.cheats,
      league: this.league,
      names: this.namesObj(),
    };
  }
  /** Nicknames by seat as a plain object (for LobbyState / view decoration). */
  private namesObj(): Record<number, string> {
    const out: Record<number, string> = {};
    for (const [sid, seat] of this.seatByClient) { const n = this.nameByClient.get(sid); if (n) out[seat] = n; }
    return out;
  }
  /** Send the appropriate state to one client: a game view, else the lobby. */
  private sendState(client: Client): void {
    if (this.isRunning()) this.sendView(client);
    else client.send("lobby", this.lobbyState());
  }
  private broadcastState(): void {
    for (const client of this.clients) this.sendState(client);
  }
  private sendView(client: Client): void {
    const seat = this.seatByClient.get(client.sessionId) ?? SPECTATOR;
    if (this.manual) { client.send("manualView", { ...this.manual.viewFor(seat), names: this.namesObj() }); return; } // free-form sandbox
    if (!this.session) return;
    client.send("view", { ...this.session.viewFor(seat), cheats: this.cheats, names: this.namesObj() }); // SeatView (+ room flags)
  }
  private pushViews(): void {
    for (const client of this.clients) this.sendView(client);
  }
}
