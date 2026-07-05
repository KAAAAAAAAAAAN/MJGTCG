import { describe, it, expect } from "vitest";
import * as M from "./reducer.js";

const { reduce: R, ActionType: AT, Phase: Ph, player, inst, replace } = M;

const mk = (iid: string, over: Partial<M.CardInstance> = {}): M.CardInstance => ({
  iid, cardId: "", atk: 1, def: 1, value: 1, tribes: [], faceDown: false,
  tapped: false, counters: {}, overlays: [], battles: 0, mods: [], ...over,
});

/** 2-player game in p0's MAIN phase with the given board instances placed. */
function game(p0: M.CardInstance[], p1: M.CardInstance[]): M.GameState {
  let s = M.newGame({ players: [0, 1], mainDeck: 20 });
  s = R(s, { type: AT.DRAW_RESOLVES });
  const put = (pid: number, ci: M.CardInstance) => {
    s = replace(s, { instances: { ...s.instances, [ci.iid]: ci } });
    s = replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, board: [...p.board, ci.iid] } : p)) });
  };
  p0.forEach((c) => put(0, c));
  p1.forEach((c) => put(1, c));
  return s;
}
/** Declare a battle and resolve it (declaration window then chain resolve). */
function fight(s: M.GameState, atk: string, def: string): M.GameState {
  s = R(s, { type: AT.DECLARE_BATTLE, attackerId: atk, targetId: def }); // -> ACTION_ANNOUNCED
  return R(s, { type: AT.RESOLVE_CHAIN }); // declaration window passes -> resolveBattle
}

describe("battle resolution", () => {
  it("ATK > DEF discards the defender; attacker survives and taps", () => {
    let s = game([mk("a", { atk: 5, def: 2 })], [mk("d", { atk: 1, def: 1 })]);
    s = fight(s, "a", "d");
    expect(player(s, 1).board).not.toContain("d");
    expect(s.discard[0]).toBe("d");
    expect(player(s, 0).board).toContain("a");
    expect(inst(s, "a").tapped).toBe(true);
  });

  it("a wall (DEF >= ATK, low ATK) survives with no discards", () => {
    let s = game([mk("a", { atk: 2, def: 2 })], [mk("d", { atk: 1, def: 5 })]);
    s = fight(s, "a", "d");
    expect(player(s, 0).board).toContain("a");
    expect(player(s, 1).board).toContain("d");
    expect(s.discard.length).toBe(0);
    expect(inst(s, "a").tapped).toBe(true);
  });

  it("mutual destruction: both discarded, defender first (attacker ends on top)", () => {
    let s = game([mk("a", { atk: 5, def: 1 })], [mk("d", { atk: 3, def: 1 })]);
    s = fight(s, "a", "d");
    expect(player(s, 0).board).not.toContain("a");
    expect(player(s, 1).board).not.toContain("d");
    expect(s.discard[0]).toBe("a"); // attacker discarded LAST -> top of pile
    expect(s.discard[1]).toBe("d");
  });

  it("uses EFFECTIVE stats: a buff changes the outcome", () => {
    // base 2/2 vs 1/3 -> no discard; +5 ATK mod makes attacker 7 ATK -> defender loses
    let s = game(
      [mk("a", { atk: 2, def: 2, mods: [{ stat: "atk", op: "add", amount: 5, duration: "persistent" }] })],
      [mk("d", { atk: 1, def: 3 })],
    );
    s = fight(s, "a", "d");
    expect(player(s, 1).board).not.toContain("d");
    expect(player(s, 0).board).toContain("a");
  });

  it("bumps battle counters for survivors (battled without leaving play)", () => {
    let s = game([mk("a", { atk: 1, def: 5 })], [mk("d", { atk: 1, def: 5 })]);
    s = fight(s, "a", "d");
    expect(inst(s, "a").battles).toBe(1);
    expect(inst(s, "d").battles).toBe(1);
  });

  it("no resolution if a participant left play before resolving", () => {
    let s = game([mk("a", { atk: 9, def: 9 })], []); // target 'd' never on a board
    s = fight(s, "a", "d");
    expect(inst(s, "a").tapped).toBe(true); // attacker still committed/taps
    expect(s.discard.length).toBe(0);
  });
});
