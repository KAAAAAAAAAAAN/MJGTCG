import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./reducer.js";
import type { Ability } from "./rules.js";

const { reduce: R, Phase: Ph, ActionType: AT, player, inst, replace, setRegistry, ReducerError } = M;

const here = dirname(fileURLToPath(import.meta.url));
const baseSet = JSON.parse(readFileSync(join(here, "../../base_set.json"), "utf-8")) as M.Card[];

const ab = (at: boolean): Ability => ({ parsed: { flags: at ? { at_any_time: true } : {} } });

// craft a board instance for battle/untap tests
const mkInst = (iid: string, over: Partial<M.CardInstance> = {}): M.CardInstance => ({
  iid, cardId: "", atk: 1, def: 1, value: 1, tribes: [], faceDown: false,
  tapped: false, counters: {}, overlays: [], battles: 0, mods: [], ...over,
});
function putOnBoard(s: M.GameState, pid: number, ci: M.CardInstance): M.GameState {
  s = replace(s, { instances: { ...s.instances, [ci.iid]: ci } });
  return replace(s, {
    players: s.players.map((p) => (p.pid === pid ? replace(p, { board: [...p.board, ci.iid] }) : p)),
  });
}

// ============================== smoke.py ====================================
describe("reducer smoke", () => {
  it("1 full normal turn + LIFO", () => {
    setRegistry({ C: ab(true), D: ab(false) });
    let s = M.newGame({ players: [0, 1], mainDeck: 40 });
    expect(s.phase).toBe(Ph.TURN_START_DRAW);
    s = R(s, { type: AT.DRAW_RESOLVES });
    expect(s.phase).toBe(Ph.MAIN_PHASE);
    expect(player(s, 0).hand.length).toBe(6);
    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "A" });
    expect(s.phase).toBe(Ph.ACTION_ANNOUNCED);
    s = R(s, { type: AT.OPEN_RESPONSE, player: 1, effectId: "B" });
    expect(s.phase).toBe(Ph.RESPONSE_WINDOW);
    s = R(s, { type: AT.ADD_TO_CHAIN, player: 0, effectId: "C" });
    expect(s.chain.length).toBe(2);
    s = R(s, { type: AT.RESOLVE_CHAIN });
    expect(s.phase).toBe(Ph.MAIN_PHASE);
    expect(s.chain.length).toBe(0);
    const lg = s.log.filter((l) => l.startsWith("resolve"));
    expect(lg[0]!.endsWith("C (player 0)")).toBe(true);
    expect(lg[1]!.endsWith("B (player 1)")).toBe(true);
  });

  it("2 pending input forbids chaining", () => {
    setRegistry({ C: ab(true), D: ab(false) });
    let s = R(M.newGame({ players: [0], mainDeck: 40 }), { type: AT.DRAW_RESOLVES });
    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "x" });
    s = R(s, { type: AT.OPEN_RESPONSE, player: 0, effectId: "x" });
    s = R(s, { type: AT.YIELD_TO_INPUT });
    expect(s.phase).toBe(Ph.PENDING_INPUT);
    expect(() => R(s, { type: AT.ADD_TO_CHAIN, player: 0, effectId: "y" })).toThrow(ReducerError);
    s = R(s, { type: AT.INPUT_COLLECTED });
    expect(s.phase).toBe(Ph.MAIN_PHASE);
  });

  it("3 battle fizzle (attacker stays untapped)", () => {
    let s = R(M.newGame({ players: [0], mainDeck: 40 }), { type: AT.DRAW_RESOLVES });
    s = putOnBoard(s, 0, mkInst("att"));
    s = R(s, { type: AT.DECLARE_BATTLE, attackerId: "att", targetId: "uY", targetRemoved: true });
    expect(s.pendingBattle).toBeNull();
    expect(inst(s, "att").tapped).toBe(false);
  });

  it("4 battle real resolve (attacker taps)", () => {
    let s = R(M.newGame({ players: [0], mainDeck: 40 }), { type: AT.DRAW_RESOLVES });
    s = putOnBoard(s, 0, mkInst("att"));
    s = R(s, { type: AT.DECLARE_BATTLE, attackerId: "att", targetId: "uY" });
    expect(s.pendingBattle).not.toBeNull();
    expect(s.phase).toBe(Ph.ACTION_ANNOUNCED); // declaration window
    expect(inst(s, "att").tapped).toBe(false);
    s = R(s, { type: AT.RESOLVE_CHAIN });
    expect(inst(s, "att").tapped).toBe(true);
  });

  it("5 empty deck eliminate (sole player -> game over, no winner)", () => {
    let s = M.newGame({ players: [0], mainDeck: 5, startingHand: 5 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    expect(player(s, 0).eliminated).toBe(true);
    expect(s.phase).toBe(Ph.GAME_OVER);
    expect(s.winner).toBeNull();
  });

  it("6 discard down: one at a time, each opens a respondable window", () => {
    let s = M.newGame({ players: [0], mainDeck: 60, startingHand: 12 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = R(s, { type: AT.END_TURN });
    expect(s.phase).toBe(Ph.DISCARD_DOWN);
    expect(() => R(s, { type: AT.OPEN_RESPONSE, player: 0, effectId: "x" })).toThrow(ReducerError);
    // each discard opens a window; closing it (RESOLVE_TOP) re-checks the hand size
    let guard = 0;
    while (s.phase !== Ph.TURN_END && guard++ < 30) {
      if (s.phase === Ph.DISCARD_DOWN) s = R(s, { type: AT.DISCARD, discardId: "c" });
      else if (s.phase === Ph.RESPONSE_WINDOW) s = R(s, { type: AT.RESOLVE_TOP });
      else break;
    }
    expect(s.phase).toBe(Ph.TURN_END);
    expect(player(s, 0).hand.length).toBe(10);
  });

  it("7 turn end untap + advance", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = putOnBoard(s, 0, mkInst("u", { tapped: true }));
    s = R(s, { type: AT.END_TURN });
    s = R(s, { type: AT.ADVANCE });
    expect(s.activePlayer).toBe(1);
    expect(s.phase).toBe(Ph.TURN_START_DRAW);
    expect(inst(s, "u").tapped).toBe(false);
  });

  it("8 Ruling 2: non-(At any time) cannot be actively chained", () => {
    setRegistry({ C: ab(true), D: ab(false) });
    let s = M.newGame({ players: [0, 1], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "A" });
    s = R(s, { type: AT.OPEN_RESPONSE, player: 1, effectId: "B" });
    expect(() => R(s, { type: AT.ADD_TO_CHAIN, player: 0, effectId: "D" })).toThrow(ReducerError);
    const s2 = R(s, { type: AT.ADD_TO_CHAIN, player: 0, effectId: "C" });
    expect(s2.chain.length).toBe(2);
  });

  it("9 Ruling 1: a player without priority cannot respond", () => {
    setRegistry({ C: ab(true), D: ab(false) });
    let s = M.newGame({ players: [0, 1, 2], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "A" });
    s = R(s, { type: AT.OPEN_RESPONSE, player: 0, effectId: "C" });
    const wrong = [0, 1, 2].find((pid) => pid !== s.prioritySeat)!;
    expect(() => R(s, { type: AT.ADD_TO_CHAIN, player: wrong, effectId: "C" })).toThrow(ReducerError);
  });

  it("RESOLVE_TOP resolves one link and reopens a window; turn player gets priority", () => {
    setRegistry({ A: ab(true), B: ab(true) });
    let s = M.newGame({ players: [0, 1, 2], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "A" });
    s = R(s, { type: AT.OPEN_RESPONSE, player: 0, effectId: "A" }); // chain link 1 (priority -> 2)
    s = R(s, { type: AT.ADD_TO_CHAIN, player: 2, effectId: "B" }); // chain link 2
    expect(s.chain.length).toBe(2);
    s = R(s, { type: AT.RESOLVE_TOP }); // resolves the top (B) only
    expect(s.chain.length).toBe(1);
    expect(s.phase).toBe(Ph.RESPONSE_WINDOW); // window reopens -> respond mid-resolution
    expect(s.prioritySeat).toBe(0); // post-resolution priority -> turn player
    s = R(s, { type: AT.RESOLVE_TOP }); // resolves the last link (A); stays in the window
    expect(s.chain.length).toBe(0);
    expect(s.phase).toBe(Ph.RESPONSE_WINDOW);
    s = R(s, { type: AT.RESOLVE_TOP }); // empty stack -> close the window
    expect(s.phase).toBe(Ph.MAIN_PHASE);
  });

  it("10 NORMAL_SUMMON: gate, Faith/CbNS legality, board placement, rollover reset", () => {
    // single player: MJG-001 normal Main; MJG-014 Faith ('F', not summonable)
    const deck = ["MJG-001", "MJG-014", "MJG-001", "MJG-001", "MJG-001", "MJG-001"];
    let s = M.newGame({ players: [0], mainDeck: deck, startingHand: 5, cardRegistry: baseSet });
    s = R(s, { type: AT.DRAW_RESOLVES });
    const norm = player(s, 0).hand.find((i) => inst(s, i).cardId === "MJG-001")!;
    const faith = player(s, 0).hand.find((i) => inst(s, i).cardId === "MJG-014")!;
    expect(() => R(s, { type: AT.NORMAL_SUMMON, player: 0, summonId: faith })).toThrow(ReducerError);
    const s1 = R(s, { type: AT.NORMAL_SUMMON, player: 0, summonId: norm });
    expect(s1.phase).toBe(Ph.ACTION_ANNOUNCED);
    expect(player(s1, 0).board).toContain(norm);
    expect(player(s1, 0).hand).not.toContain(norm);
    expect(player(s1, 0).summonedThisTurn).toBe(true);
    expect(player(s1, 0).actedThisTurn).toBe(true); // a summon counts as an action
    const s1m = replace(s1, { phase: Ph.MAIN_PHASE });
    const norm2 = player(s1m, 0).hand.find((i) => inst(s1m, i).cardId === "MJG-001")!;
    expect(() => R(s1m, { type: AT.NORMAL_SUMMON, player: 0, summonId: norm2 })).toThrow(ReducerError);
    // gate resets after rollover
    let s2 = replace(s1m, { phase: Ph.TURN_END });
    s2 = R(s2, { type: AT.ADVANCE });
    expect(player(s2, 0).summonedThisTurn).toBe(false);
    expect(player(s2, 0).actedThisTurn).toBe(false); // reset on rollover
  });

  it("10b only the turn player may normal summon", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    const someIid = player(s, 1).hand[0];
    expect(() => R(s, { type: AT.NORMAL_SUMMON, player: 1, summonId: someIid })).toThrow(ReducerError);
  });
});

// ========================= test_integration.py ==============================
describe("reducer integration", () => {
  it("R3 KAN resolves immediately, no window, then open game state", () => {
    let s = M.newGame({ players: [0], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    for (const id of ["a", "b", "c", "d"]) s = putOnBoard(s, 0, mkInst(id, { value: 5 }));
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
    s = replace(s, { phase: Ph.MAIN_PHASE });
    const h0 = player(s, 0).hand.length;
    s = R(s, { type: AT.RESOLVE_KAN, player: 0, meldIndex: 0, kanMaterial: "d" });
    expect(s.phase).toBe(Ph.MAIN_PHASE);
    expect(player(s, 0).hand.length).toBe(h0 + 1); // drew bottom of Main
    expect(s.chain.length).toBe(0);
    expect(s.log.some((l) => l.includes("no response window"))).toBe(true);
  });

  it("R5 SEGOC trigger batch — turn player first, then anticlockwise", () => {
    let s = M.newGame({ players: [0, 1, 2], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    const trigs = [
      { player: 2, id: "t2" },
      { player: 1, id: "t1" },
      { player: 0, id: "t0" },
    ];
    s = R(s, { type: AT.OPEN_TRIGGER_BATCH, player: 0, triggers: trigs });
    expect(s.phase).toBe(Ph.RESPONSE_WINDOW);
    expect(s.chain.map((l) => l.sourcePlayer)).toEqual([0, 2, 1]);
    expect(s.prioritySeat).toBe(0);
  });

  it("once-per-turn enforced through the reducer", () => {
    setRegistry({
      OPT: { parsed: { flags: { once_per_turn: true } } },
      FREE: { parsed: { flags: {} } },
    });
    let s = M.newGame({ players: [0, 1], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "OPT" });
    expect(s.phase).toBe(Ph.ACTION_ANNOUNCED);
    s = replace(s, { phase: Ph.MAIN_PHASE });
    expect(() => R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "OPT" })).toThrow(ReducerError);
    let s2 = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "FREE" });
    s2 = replace(s2, { phase: Ph.MAIN_PHASE });
    expect(() => R(s2, { type: AT.PLAYER_ACTS, player: 0, effectId: "FREE" })).not.toThrow();
  });

  it("once-per-turn reopens next turn after reset", () => {
    setRegistry({ OPT: { parsed: { flags: { once_per_turn: true } } } });
    let s = M.newGame({ players: [0, 1], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "OPT" });
    s = replace(s, { phase: Ph.TURN_END });
    s = R(s, { type: AT.ADVANCE });
    s = R(s, { type: AT.DRAW_RESOLVES });
    expect(s.activePlayer).toBe(1);
    expect(() => R(s, { type: AT.PLAYER_ACTS, player: 1, effectId: "OPT" })).not.toThrow();
  });

  it("turn order is anticlockwise with 3 players", () => {
    let s = M.newGame({ players: [0, 1, 2], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = replace(s, { phase: Ph.TURN_END });
    s = R(s, { type: AT.ADVANCE });
    expect(s.activePlayer).toBe(2);
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = replace(s, { phase: Ph.TURN_END });
    s = R(s, { type: AT.ADVANCE });
    expect(s.activePlayer).toBe(1);
  });
});

// ============================ meld + KAN (0b) ===============================
describe("meld + KAN", () => {
  // helper: fresh single-player game in MAIN with the given board instances
  function withBoard(board: M.CardInstance[], faith = 0): M.GameState {
    let s = M.newGame({ players: [0], mainDeck: 40, faithDeck: faith });
    s = R(s, { type: AT.DRAW_RESOLVES });
    for (const ci of board) s = putOnBoard(s, 0, ci);
    return s;
  }

  it("normal triplet meld: moves to meld zone, gates, draws Faith", () => {
    let s = withBoard([mkInst("a", { value: 5 }), mkInst("b", { value: 5 }), mkInst("c", { value: 5 })], 3);
    const h0 = player(s, 0).hand.length;
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
    expect(s.phase).toBe(Ph.ACTION_ANNOUNCED);
    const mz = player(s, 0).meldZone;
    expect(mz.length).toBe(1);
    expect(mz[0]!.kind).toBe("triplet");
    expect(mz[0]!.kan).toBe(false);
    expect(player(s, 0).board).toEqual([]);
    expect(player(s, 0).meldedThisTurn).toBe(true);
    expect(player(s, 0).hand.length).toBe(h0 + 1); // Faith draw
    expect(s.faithDeck.length).toBe(2);
  });

  it("sequence meld (2-3-4) is valid", () => {
    let s = withBoard([mkInst("a", { value: 2 }), mkInst("b", { value: 3 }), mkInst("c", { value: 4 })]);
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
    expect(player(s, 0).meldZone[0]!.kind).toBe("sequence");
  });

  it("invalid values (2-2-5) rejected", () => {
    const s = withBoard([mkInst("a", { value: 2 }), mkInst("b", { value: 2 }), mkInst("c", { value: 5 })]);
    expect(() => R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] })).toThrow(ReducerError);
  });

  it("second normal meld same turn blocked; special meld bypasses the gate", () => {
    let s = withBoard(
      [
        mkInst("a", { value: 5 }), mkInst("b", { value: 5 }), mkInst("c", { value: 5 }),
        mkInst("d", { value: 3 }), mkInst("e", { value: 3 }), mkInst("f", { value: 3 }),
      ],
      5,
    );
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
    s = replace(s, { phase: Ph.MAIN_PHASE });
    expect(() => R(s, { type: AT.MELD, player: 0, materials: ["d", "e", "f"] })).toThrow(ReducerError);
    const s2 = R(s, { type: AT.MELD, player: 0, special: true, materials: ["d", "e", "f"] });
    expect(player(s2, 0).meldZone.length).toBe(2);
  });

  it("meld using the top of the discard pile", () => {
    let s = withBoard([mkInst("a", { value: 5 }), mkInst("b", { value: 5 })]);
    // place a value-5 instance on top of the discard pile
    const t = mkInst("t", { value: 5 });
    s = replace(s, { instances: { ...s.instances, t }, discard: ["t", ...s.discard] });
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "t"] });
    expect(player(s, 0).meldZone.length).toBe(1);
    expect(s.discard).not.toContain("t");
  });

  it("☆ wild fills either a triplet or a sequence", () => {
    expect(M.meldKind([null, 5, 5])).toBe("triplet");
    expect(M.meldKind([null, 2, 4])).toBe("sequence");
    expect(M.meldKind([2, 2, 5])).toBeNull();
    let s = withBoard([mkInst("a", { value: null }), mkInst("b", { value: 2 }), mkInst("c", { value: 4 })]);
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
    expect(player(s, 0).meldZone[0]!.kind).toBe("sequence");
  });

  it("canExtendMeld — order-independent, ☆ wild (UI selection gate)", () => {
    const ext = M.canExtendMeld;
    // first pick: anything (and ☆) is fine
    for (const v of [1, 2, 9, null]) expect(ext([], v)).toBe(true);
    // after a 4: any value within a 3-window — 2,3,4,5,6 — but not 1 or 7
    for (const v of [2, 3, 4, 5, 6]) expect(ext([4], v)).toBe(true);
    expect(ext([4], 1)).toBe(false);
    expect(ext([4], 7)).toBe(false);
    expect(ext([4], null)).toBe(true); // ☆ always extends
    // 4 then 6 (a gap): only 5 completes 4-5-6
    expect(ext([4, 6], 5)).toBe(true);
    expect(ext([4, 6], 4)).toBe(false); // 4,6,4 -> neither triplet nor sequence
    expect(ext([4, 6], 7)).toBe(false);
    expect(ext([4, 6], 3)).toBe(false);
    // 4 then 2 (the other gap): only 3 completes 2-3-4
    expect(ext([4, 2], 3)).toBe(true);
    expect(ext([4, 2], 5)).toBe(false);
    // triplet path: 2,2 -> only another 2
    expect(ext([2, 2], 2)).toBe(true);
    expect(ext([2, 2], 3)).toBe(false);
    // ☆ stays flexible and never over-constrains
    expect(ext([2, null], 4)).toBe(true);
    expect(ext([2, null], 5)).toBe(false); // 2 and 5 can't share a meld
    // a full selection can't be extended
    expect(ext([1, 2, 3], 4)).toBe(false);
  });

  it("DEV_SPAWN drops a card with real stats into a hand (any phase)", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0, cardRegistry: baseSet });
    const ref = baseSet.find((c) => c.id === "MJG-011")!; // Haruna (vanilla)
    s = R(s, { type: AT.DEV_SPAWN, player: 1, spawnCardId: "MJG-011", spawnIid: "dev-0" });
    expect(player(s, 1).hand).toContain("dev-0");
    const ci = inst(s, "dev-0");
    expect(ci.cardId).toBe("MJG-011");
    expect(ci.atk).toBe(ref.atk);
    expect(ci.def).toBe(ref.def);
    // re-using an existing iid is rejected
    expect(() => R(s, { type: AT.DEV_SPAWN, player: 0, spawnCardId: "MJG-011", spawnIid: "dev-0" })).toThrow(ReducerError);
  });

  it("noFaith suppresses the Faith draw", () => {
    let s = withBoard([mkInst("a", { value: 5 }), mkInst("b", { value: 5 }), mkInst("c", { value: 5 })], 3);
    const h0 = player(s, 0).hand.length;
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"], noFaith: true });
    expect(player(s, 0).hand.length).toBe(h0);
    expect(s.faithDeck.length).toBe(3);
  });

  it("KAN adds a 4th to a triplet and draws bottom of Main; rejects on a sequence", () => {
    let s = withBoard([mkInst("a", { value: 5 }), mkInst("b", { value: 5 }), mkInst("c", { value: 5 }), mkInst("d", { value: 5 })]);
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
    s = replace(s, { phase: Ph.MAIN_PHASE });
    const h0 = player(s, 0).hand.length;
    s = R(s, { type: AT.RESOLVE_KAN, player: 0, meldIndex: 0, kanMaterial: "d" });
    const m = player(s, 0).meldZone[0]!;
    expect(m.cards.length).toBe(4);
    expect(m.kan).toBe(true);
    expect(player(s, 0).board).not.toContain("d");
    expect(player(s, 0).hand.length).toBe(h0 + 1);

    // cannot KAN a sequence meld
    let s2 = withBoard([mkInst("p", { value: 2 }), mkInst("q", { value: 3 }), mkInst("r", { value: 4 }), mkInst("x", { value: 3 })]);
    s2 = R(s2, { type: AT.MELD, player: 0, materials: ["p", "q", "r"] });
    s2 = replace(s2, { phase: Ph.MAIN_PHASE });
    expect(() => R(s2, { type: AT.RESOLVE_KAN, player: 0, meldIndex: 0, kanMaterial: "x" })).toThrow(ReducerError);
  });

  it("MJG-HAT bottom: a wild-VALUE KAN material usable from anywhere (unless negated)", () => {
    const triplet = (): M.GameState => {
      let s = withBoard([mkInst("a", { value: 5 }), mkInst("b", { value: 5 }), mkInst("c", { value: 5 })]);
      s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
      return replace(s, { phase: Ph.MAIN_PHASE });
    };
    // from HAND, VALUE 4 (mismatches the 5-5-5 triplet) -> the wild KAN still succeeds
    let s = triplet();
    s = replace(s, {
      instances: { ...s.instances, hat: mkInst("hat", { cardId: "MJG-HAT", value: 4 }) },
      players: s.players.map((p) => (p.pid === 0 ? replace(p, { hand: [...p.hand, "hat"] }) : p)),
    });
    s = R(s, { type: AT.RESOLVE_KAN, player: 0, meldIndex: 0, kanMaterial: "hat" });
    expect(player(s, 0).meldZone[0]!.kan).toBe(true);
    expect(player(s, 0).meldZone[0]!.cards).toContain("hat");
    expect(player(s, 0).hand).not.toContain("hat"); // left the hand

    // from the DISCARD pile -> also works
    let s2 = triplet();
    s2 = replace(s2, { instances: { ...s2.instances, hat: mkInst("hat", { cardId: "MJG-HAT", value: 9 }) }, discard: ["hat"] });
    s2 = R(s2, { type: AT.RESOLVE_KAN, player: 0, meldIndex: 0, kanMaterial: "hat" });
    expect(player(s2, 0).meldZone[0]!.kan).toBe(true);
    expect(s2.discard).not.toContain("hat");

    // a NEGATED copy loses the property -> a mismatched value from hand is rejected
    let s3 = triplet();
    s3 = replace(s3, {
      instances: { ...s3.instances, hat: mkInst("hat", { cardId: "MJG-HAT", value: 4, effectsNegated: true }) },
      players: s3.players.map((p) => (p.pid === 0 ? replace(p, { hand: [...p.hand, "hat"] }) : p)),
    });
    expect(() => R(s3, { type: AT.RESOLVE_KAN, player: 0, meldIndex: 0, kanMaterial: "hat" })).toThrow(ReducerError);
  });

  it("MJG-C01 'Rinshan Kaihou': KAN from hand/discard-top, Faith-searching instead of drawing", () => {
    const setup5 = (): M.GameState => {
      let s = withBoard([mkInst("a", { value: 5 }), mkInst("b", { value: 5 }), mkInst("c", { value: 5 }), mkInst("cb", { cardId: "MJG-C01" })], 5);
      s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] }); // the normal meld draws 1 Faith
      return replace(s, { phase: Ph.MAIN_PHASE });
    };
    // KAN with a VALUE-5 card FROM HAND (Rinshan source); the draw is replaced by a
    // Faith search for any 1 card — the Main deck is untouched.
    let s = setup5();
    const fc = s.faithDeck[1]!; // any card (not necessarily the top)
    s = replace(s, {
      instances: { ...s.instances, h5: mkInst("h5", { value: 5 }) },
      players: s.players.map((p) => (p.pid === 0 ? replace(p, { hand: [...p.hand, "h5"] }) : p)),
    });
    const main0 = s.mainDeck.length;
    s = R(s, { type: AT.RESOLVE_KAN, player: 0, meldIndex: 0, kanMaterial: "h5", faithSearch: fc });
    expect(player(s, 0).meldZone[0]!.kan).toBe(true);
    expect(player(s, 0).meldZone[0]!.cards).toContain("h5");
    expect(player(s, 0).hand).toContain(fc); // the searched Faith card
    expect(s.faithDeck).not.toContain(fc);
    expect(s.mainDeck.length).toBe(main0); // NO bottom-of-Main draw

    // KAN with the DISCARD TOP (also a Rinshan source)
    let s2 = setup5();
    s2 = replace(s2, { instances: { ...s2.instances, d5: mkInst("d5", { value: 5 }) }, discard: ["d5"] });
    s2 = R(s2, { type: AT.RESOLVE_KAN, player: 0, meldIndex: 0, kanMaterial: "d5" });
    expect(player(s2, 0).meldZone[0]!.cards).toContain("d5");
    expect(s2.discard).not.toContain("d5");
  });

  it("a hand/discard KAN material is rejected without Cute Boy (or SHAMIKO)", () => {
    let s = withBoard([mkInst("a", { value: 5 }), mkInst("b", { value: 5 }), mkInst("c", { value: 5 })]);
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
    s = replace(s, {
      phase: Ph.MAIN_PHASE,
      instances: { ...s.instances, h5: mkInst("h5", { value: 5 }) },
      players: s.players.map((p) => (p.pid === 0 ? replace(p, { hand: [...p.hand, "h5"] }) : p)),
    });
    expect(() => R(s, { type: AT.RESOLVE_KAN, player: 0, meldIndex: 0, kanMaterial: "h5" })).toThrow(ReducerError);
  });
});

// ========================= win + elimination (0c) ===========================
describe("win + elimination", () => {
  const dummyMeld: M.Meld = { cards: ["x", "y", "z"], kind: "triplet", kan: false };

  it("completing the 4th meld wins the game", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    for (const id of ["a", "b", "c"]) s = putOnBoard(s, 0, mkInst(id, { value: 7 }));
    // give player 0 three existing melds
    s = replace(s, {
      players: s.players.map((p) =>
        p.pid === 0 ? replace(p, { meldZone: [dummyMeld, dummyMeld, dummyMeld] }) : p,
      ),
    });
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
    expect(s.phase).toBe(Ph.GAME_OVER);
    expect(s.winner).toBe(0);
    // no further actions once the game is over
    expect(() => R(s, { type: AT.END_TURN })).toThrow(ReducerError);
  });

  it("third meld does NOT win", () => {
    let s = M.newGame({ players: [0], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    for (const id of ["a", "b", "c"]) s = putOnBoard(s, 0, mkInst(id, { value: 7 }));
    s = replace(s, {
      players: s.players.map((p) => (p.pid === 0 ? replace(p, { meldZone: [dummyMeld, dummyMeld] }) : p)),
    });
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
    expect(s.phase).toBe(Ph.ACTION_ANNOUNCED);
    expect(s.winner).toBeNull();
    expect(player(s, 0).meldZone.length).toBe(3);
  });

  it("empty-deck draw eliminates -> last player standing wins, ghost board cleared", () => {
    // 2 players, deck of 10: dealing 5 each empties it -> p0's turn draw fails
    let s = M.newGame({ players: [0, 1], mainDeck: 10, startingHand: 5 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    expect(player(s, 0).eliminated).toBe(true);
    expect(player(s, 0).hand.length).toBe(0); // ghost board
    expect(player(s, 0).board.length).toBe(0);
    expect(s.phase).toBe(Ph.GAME_OVER);
    expect(s.winner).toBe(1);
  });

  it("3-player: elimination continues play (no winner yet)", () => {
    let s = M.newGame({ players: [0, 1, 2], mainDeck: 15, startingHand: 5 });
    s = R(s, { type: AT.DRAW_RESOLVES }); // p0 draws from empty -> eliminated, 2 remain
    expect(player(s, 0).eliminated).toBe(true);
    expect(s.phase).toBe(Ph.TURN_END);
    expect(s.winner).toBeNull();
    s = R(s, { type: AT.ADVANCE }); // skips to a living player
    expect([1, 2]).toContain(s.activePlayer);
  });
});

describe("☆ (wild) meld value pinning", () => {
  it("meldAssignments enumerates the distinct valid value-tuples", () => {
    expect(M.meldAssignments([2, 4, null])).toEqual([[2, 3, 4]]); // forced
    expect(M.meldAssignments([2, 3, null])).toEqual([[1, 2, 3], [2, 3, 4]]); // ambiguous
    const t = M.meldAssignments([2, null, null]);
    expect(t).toContainEqual([1, 2, 3]);
    expect(t).toContainEqual([2, 2, 2]);
    expect(t).toContainEqual([2, 3, 4]);
    expect(M.meldAssignments([5, 5, 5])).toEqual([[5, 5, 5]]); // no stars -> itself
    expect(M.meldAssignments([2, 5, 8])).toEqual([]); // not a meld at all
  });

  it("MELD with values pins the ☆ and records the resolved values", () => {
    let s = M.newGame({ players: [0], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = putOnBoard(s, 0, mkInst("a", { value: 2 }));
    s = putOnBoard(s, 0, mkInst("b", { value: 4 }));
    s = putOnBoard(s, 0, mkInst("c", { value: null })); // ☆
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"], values: [2, 4, 3] });
    const m = player(s, 0).meldZone[0]!;
    expect(m.kind).toBe("sequence");
    expect(m.values).toEqual([2, 4, 3]); // the ☆ is pinned to 3
  });

  it("MELD rejects values that don't form a meld or contradict a fixed material", () => {
    let s = M.newGame({ players: [0], mainDeck: 40 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = putOnBoard(s, 0, mkInst("a", { value: 2 }));
    s = putOnBoard(s, 0, mkInst("b", { value: 4 }));
    s = putOnBoard(s, 0, mkInst("c", { value: null }));
    expect(() => R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"], values: [2, 4, 9] })).toThrow(ReducerError); // 2,4,9 not a meld
    expect(() => R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"], values: [9, 4, 3] })).toThrow(ReducerError); // 'a' is fixed at 2
  });
});
