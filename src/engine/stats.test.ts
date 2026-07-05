import { describe, it, expect } from "vitest";
import * as M from "./reducer.js";
import * as E from "./effects.js";
import { getScript } from "./card-scripts.js";

const { reduce: R, ActionType: AT, Phase: Ph, player, replace } = M;

const mk = (iid: string, over: Partial<M.CardInstance> = {}): M.CardInstance => ({
  iid, cardId: "", atk: 3, def: 3, value: 3, tribes: [], faceDown: false,
  tapped: false, counters: {}, overlays: [], battles: 0, mods: [], ...over,
});
function withInstances(...cis: M.CardInstance[]): M.GameState {
  let s = M.newGame({ players: [0, 1], mainDeck: 10 });
  for (const ci of cis) {
    s = replace(s, { instances: { ...s.instances, [ci.iid]: ci } });
    s = replace(s, { players: s.players.map((p) => (p.pid === 0 ? { ...p, board: [...p.board, ci.iid] } : p)) });
  }
  return s;
}

describe("effective-stat model", () => {
  it("base stats with no mods", () => {
    const s = withInstances(mk("a", { atk: 4, def: 2, value: 6 }));
    expect(M.atkOf(s, "a")).toBe(4);
    expect(M.defOf(s, "a")).toBe(2);
    expect(M.valueOf(s, "a")).toBe(6);
  });

  it("add / set / mul apply in order", () => {
    const s = withInstances(
      mk("a", { atk: 3, mods: [{ stat: "atk", op: "add", amount: 2, duration: "persistent" }] }), // 5
      mk("b", { atk: 3, mods: [{ stat: "atk", op: "set", amount: 9, duration: "persistent" }] }), // 9
      mk("c", { atk: 3, mods: [{ stat: "atk", op: "mul", amount: 2, duration: "persistent" }] }), // 6
    );
    expect(M.atkOf(s, "a")).toBe(5);
    expect(M.atkOf(s, "b")).toBe(9);
    expect(M.atkOf(s, "c")).toBe(6);
  });

  it("floors: ATK/DEF min 0, VALUE min 1", () => {
    const s = withInstances(
      mk("a", { atk: 1, mods: [{ stat: "atk", op: "add", amount: -5, duration: "persistent" }] }),
      mk("b", { value: 2, mods: [{ stat: "value", op: "add", amount: -9, duration: "persistent" }] }),
    );
    expect(M.atkOf(s, "a")).toBe(0); // not -4
    expect(M.valueOf(s, "b")).toBe(1); // not -7
  });

  it("☆ VALUE stays null unless set", () => {
    const s = withInstances(
      mk("star", { value: null }),
      mk("set", { value: null, mods: [{ stat: "value", op: "set", amount: 5, duration: "persistent" }] }),
    );
    expect(M.valueOf(s, "star")).toBeNull();
    expect(M.valueOf(s, "set")).toBe(5);
  });
});

describe("statMod intent", () => {
  it("appends a modifier; effective stat reflects it", () => {
    const s = withInstances(mk("a", { atk: 3 }));
    const out = E.applyIntent(s, { kind: "statMod", iid: "a", stat: "atk", op: "add", amount: 4, duration: "persistent" }).state;
    expect(M.atkOf(out, "a")).toBe(7);
  });
});

describe("durations & leave-play", () => {
  it("end-of-turn mods expire on ADVANCE; persistent ones remain", () => {
    let s = withInstances(
      mk("a", { atk: 3, mods: [{ stat: "atk", op: "add", amount: 5, duration: "endOfTurn" }] }),
      mk("b", { atk: 3, mods: [{ stat: "atk", op: "add", amount: 5, duration: "persistent" }] }),
    );
    expect(M.atkOf(s, "a")).toBe(8);
    s = R(replace(s, { phase: Ph.TURN_END }), { type: AT.ADVANCE });
    expect(M.atkOf(s, "a")).toBe(3); // expired
    expect(M.atkOf(s, "b")).toBe(8); // persists
  });

  it("leaving play clears mods and counters", () => {
    const s = withInstances(
      mk("a", { atk: 3, counters: { code: 2 }, mods: [{ stat: "atk", op: "add", amount: 5, duration: "persistent" }] }),
    );
    expect(M.atkOf(s, "a")).toBe(8);
    const out = E.applyIntent(s, { kind: "moveTo", iid: "a", to: "hand" }).state;
    expect(M.inst(out, "a").mods).toEqual([]);
    expect(M.inst(out, "a").counters).toEqual({});
  });
});

describe("meld uses effective VALUE", () => {
  it("a VALUE mod can make an otherwise-invalid meld legal", () => {
    // 2,3,5 is not a sequence; set the 5 -> 4 to make 2-3-4
    let s = M.newGame({ players: [0], mainDeck: 10 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    for (const [id, v] of [["a", 2], ["b", 3], ["c", 5]] as const) {
      const ci = mk(id, { value: v });
      s = replace(s, { instances: { ...s.instances, [id]: ci } });
      s = replace(s, { players: s.players.map((p) => (p.pid === 0 ? { ...p, board: [...p.board, id] } : p)) });
    }
    expect(() => R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] })).toThrow(M.ReducerError);
    s = E.applyIntent(s, { kind: "statMod", iid: "c", stat: "value", op: "set", amount: 4, duration: "endOfTurn" }).state;
    s = R(s, { type: AT.MELD, player: 0, materials: ["a", "b", "c"] });
    expect(player(s, 0).meldZone[0]!.kind).toBe("sequence");
  });
});

describe("Mommy Milkers 'From the Source' (MJG-32歳:bottom)", () => {
  it("doubles the target's ATK and DEF until end of turn", () => {
    const s = withInstances(mk("tgt", { atk: 3, def: 4 }));
    const out = E.runEffect(s, getScript("MJG-32歳", "bottom")!, { controller: 0, self: "self", targets: ["tgt"] });
    expect(M.atkOf(out, "tgt")).toBe(6);
    expect(M.defOf(out, "tgt")).toBe(8);
    // and it wears off at end of turn
    const after = R(replace(out, { phase: Ph.TURN_END }), { type: AT.ADVANCE });
    expect(M.atkOf(after, "tgt")).toBe(3);
    expect(M.defOf(after, "tgt")).toBe(4);
  });
});
