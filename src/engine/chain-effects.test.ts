import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./reducer.js";
import * as E from "./effects.js";

const here = dirname(fileURLToPath(import.meta.url));
const baseSet = JSON.parse(readFileSync(join(here, "../../base_set.json"), "utf-8")) as M.Card[];
const { reduce: R, ActionType: AT, Phase: Ph, player } = M;

// wire the effect resolver into the reducer (index.ts does this for real apps)
beforeAll(() => M.setEffectResolver(E.resolveChainLink));

describe("chain resolution runs card scripts (1c)", () => {
  it("activate -> window -> resolve runs the script (Nyagger top)", () => {
    const deck = ["MJG-001", ...Array<string>(15).fill("MJG-011")];
    let s = M.newGame({ players: [0], mainDeck: deck, startingHand: 5, cardRegistry: baseSet });
    s = R(s, { type: AT.DRAW_RESOLVES });
    const self = player(s, 0).hand.find((i) => s.instances[i]!.cardId === "MJG-001")!;
    const deck0 = s.mainDeck.length;

    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "MJG-001:top" });
    s = R(s, {
      type: AT.OPEN_RESPONSE,
      player: 0,
      effectId: "MJG-001:top",
      script: { cardId: "MJG-001", role: "top", self },
    });
    s = R(s, { type: AT.RESOLVE_CHAIN });

    expect(s.phase).toBe(Ph.MAIN_PHASE);
    expect(player(s, 0).board).toContain(self); // special-summoned self
    expect(player(s, 0).hand).not.toContain(self);
    expect(s.mainDeck.length).toBe(deck0 - 1); // drew 1
  });

  it("LIFO: a response script resolves before the script it responded to", () => {
    M.setRegistry({ "MJG-013:top": { parsed: { flags: { at_any_time: true } } } });
    // 2 players, anticlockwise deal [0,1] -> MJG-013 at idx0->p0, idx1->p1
    const deck = ["MJG-013", "MJG-013", ...Array<string>(20).fill("MJG-011")];
    let s = M.newGame({ players: [0, 1], mainDeck: deck, startingHand: 5, cardRegistry: baseSet });
    s = R(s, { type: AT.DRAW_RESOLVES });
    const self0 = player(s, 0).hand.find((i) => s.instances[i]!.cardId === "MJG-013")!;
    const self1 = player(s, 1).hand.find((i) => s.instances[i]!.cardId === "MJG-013")!;

    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "MJG-013:top" });
    s = R(s, {
      type: AT.OPEN_RESPONSE,
      player: 0,
      effectId: "MJG-013:top",
      script: { cardId: "MJG-013", role: "top", self: self0 },
    });
    // priority is now on p1; they respond with their own (At any time) Banana
    s = R(s, {
      type: AT.ADD_TO_CHAIN,
      player: 1,
      effectId: "MJG-013:top",
      script: { cardId: "MJG-013", role: "top", self: self1 },
    });
    expect(s.chain.length).toBe(2);
    s = R(s, { type: AT.RESOLVE_CHAIN });

    // both summons happened...
    expect(player(s, 0).board).toContain(self0);
    expect(player(s, 1).board).toContain(self1);
    // ...and the responder (p1) resolved FIRST (LIFO)
    const resolves = s.log.filter((l) => l.startsWith("resolve "));
    expect(resolves[0]!.endsWith("(player 1)")).toBe(true);
    expect(resolves[1]!.endsWith("(player 0)")).toBe(true);
  });

  it("targets thread through the chain into the script (Mr Rabbit bounce)", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 20, cardRegistry: baseSet });
    s = R(s, { type: AT.DRAW_RESOLVES });
    // put a target on p1's board
    const tgt = "p1-tgt";
    const ci: M.CardInstance = {
      iid: tgt, cardId: "", atk: 1, def: 1, value: 1, tribes: [], faceDown: false,
      tapped: false, counters: {}, overlays: [], battles: 0, mods: [],
    };
    s = M.replace(s, { instances: { ...s.instances, [tgt]: ci } });
    s = M.replace(s, { players: s.players.map((p) => (p.pid === 1 ? { ...p, board: [...p.board, tgt] } : p)) });

    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "MJG-018:bottom" });
    s = R(s, {
      type: AT.OPEN_RESPONSE,
      player: 0,
      effectId: "MJG-018:bottom",
      script: { cardId: "MJG-018", role: "bottom", self: "src", targets: [tgt] },
    });
    s = R(s, { type: AT.RESOLVE_CHAIN });
    expect(player(s, 1).hand).toContain(tgt); // bounced to owner's hand via the chain
    expect(player(s, 1).board).not.toContain(tgt);
  });

  it("a chain link with no script is inert (logged only)", () => {
    let s = M.newGame({ players: [0], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    const board0 = player(s, 0).board.length;
    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "X" });
    s = R(s, { type: AT.OPEN_RESPONSE, player: 0, effectId: "X" }); // no script ref
    s = R(s, { type: AT.RESOLVE_CHAIN });
    expect(s.phase).toBe(Ph.MAIN_PHASE);
    expect(player(s, 0).board.length).toBe(board0); // nothing happened
  });
});
