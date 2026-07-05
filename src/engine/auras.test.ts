import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./reducer.js";
import * as E from "./effects.js";
import { getScript } from "./card-scripts.js";
import { CONTINUOUS_AURAS, computeAuras } from "./auras.js";

const { replace } = M;
const here = dirname(fileURLToPath(import.meta.url));
type Card = { id: string; abilities: { role?: string; text?: string }[] };
const baseSet = JSON.parse(readFileSync(join(here, "../../base_set.json"), "utf-8")) as Card[];
const byId = new Map(baseSet.map((c) => [c.id, c]));

beforeAll(() => M.setAuraProvider(computeAuras));

const mk = (iid: string, over: Partial<M.CardInstance> = {}): M.CardInstance => ({
  iid, cardId: "", atk: 0, def: 0, value: 0, tribes: [], faceDown: false,
  tapped: false, counters: {}, overlays: [], battles: 0, mods: [], ...over,
});
/** game with the given instances placed on the given players' boards / hands */
function build(spec: { board?: [number, M.CardInstance][]; hand?: [number, M.CardInstance][]; banish?: string[] }): M.GameState {
  let s = M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0 }); // empty hands for exact counts
  for (const [, ci] of [...(spec.board ?? []), ...(spec.hand ?? [])])
    s = replace(s, { instances: { ...s.instances, [ci.iid]: ci } });
  for (const [pid, ci] of spec.board ?? [])
    s = replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, board: [...p.board, ci.iid] } : p)) });
  for (const [pid, ci] of spec.hand ?? [])
    s = replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, hand: [...p.hand, ci.iid] } : p)) });
  if (spec.banish) s = replace(s, { banish: spec.banish });
  return s;
}

describe("aura registry integrity", () => {
  it("every CONTINUOUS_AURAS key maps to a real ability with text", () => {
    const bad: string[] = [];
    for (const key of Object.keys(CONTINUOUS_AURAS)) {
      const [id, role] = key.split(":");
      const card = byId.get(id!);
      if (!card || !card.abilities.some((a) => a.role === role && (a.text ?? "").trim())) bad.push(key);
    }
    expect(bad).toEqual([]);
  });
});

describe("Strength in Numbers (furry lord)", () => {
  it("+1 ATK/DEF per OTHER Furry on any board", () => {
    // Mating (Furry, base 3/3) + two other Furries across both boards
    const s = build({
      board: [
        [0, mk("lord", { cardId: "MJG-0w0", atk: 3, def: 3, tribes: ["Furry"] })],
        [0, mk("f1", { tribes: ["Furry"] })],
        [1, mk("f2", { tribes: ["Furry"] })],
        [1, mk("nonfurry", { tribes: ["Hag"] })],
      ],
    });
    expect(M.atkOf(s, "lord")).toBe(5); // 3 + 2 others
    expect(M.defOf(s, "lord")).toBe(5);
  });

  it("counts zero others -> base stats", () => {
    const s = build({ board: [[0, mk("lord", { cardId: "MJG-0w0", atk: 3, def: 3, tribes: ["Furry"] })]] });
    expect(M.atkOf(s, "lord")).toBe(3);
  });

  it("two lords each count the other (no recursion)", () => {
    const s = build({
      board: [
        [0, mk("a", { cardId: "MJG-0w0", atk: 3, def: 3, tribes: ["Furry"] })],
        [1, mk("b", { cardId: "MJG-M07", atk: 3, def: 3, tribes: ["Furry"] })],
      ],
    });
    expect(M.atkOf(s, "a")).toBe(4); // +1 for b
    expect(M.atkOf(s, "b")).toBe(4); // +1 for a
  });

  it("face-down Furries are not counted, and a face-down lord gives no aura", () => {
    const s = build({
      board: [
        [0, mk("lord", { cardId: "MJG-0w0", atk: 3, def: 3, tribes: ["Furry"] })],
        [0, mk("fd", { tribes: ["Furry"], faceDown: true })],
      ],
    });
    expect(M.atkOf(s, "lord")).toBe(3); // face-down furry uncounted
  });
});

describe("Ojisan: +1 DEF to controller's characters", () => {
  it("buffs own board (including self), not the opponent's", () => {
    const s = build({
      board: [
        [0, mk("oji", { cardId: "MJG-C28", atk: 1, def: 4 })],
        [0, mk("ally", { def: 2 })],
        [1, mk("foe", { def: 2 })],
      ],
    });
    expect(M.defOf(s, "oji")).toBe(5); // 4 + 1 (incl self)
    expect(M.defOf(s, "ally")).toBe(3); // 2 + 1
    expect(M.defOf(s, "foe")).toBe(2); // unaffected
  });
});

describe("count-based self auras", () => {
  it("Tyrant's Hand: +1 ATK / -1 VALUE (min 1) per banished card", () => {
    const s = build({
      board: [[0, mk("goth", { cardId: "MJG-022", atk: 1, def: 5, value: 9 })]],
      banish: ["x", "y", "z"], // 3 banished
    });
    expect(M.atkOf(s, "goth")).toBe(4); // 1 + 3
    expect(M.valueOf(s, "goth")).toBe(6); // 9 - 3
  });

  it("Milked: -1 ATK/DEF (min 0) per card in your hand", () => {
    const s = build({
      board: [[0, mk("momy", { cardId: "MJG-32歳", atk: 8, def: 8, value: 8 })]],
      hand: [
        [0, mk("h1")],
        [0, mk("h2")],
      ],
    });
    expect(M.atkOf(s, "momy")).toBe(6); // 8 - 2
    expect(M.defOf(s, "momy")).toBe(6);
  });

  it("floors hold: huge hand can't push Milked below 0", () => {
    const hand: [number, M.CardInstance][] = Array.from({ length: 12 }, (_, i) => [0, mk(`h${i}`)]);
    const s = build({ board: [[0, mk("momy", { cardId: "MJG-32歳", atk: 8, def: 8, value: 8 })]], hand });
    expect(M.atkOf(s, "momy")).toBe(0); // 8 - 12 floored at 0
  });

  // regression: "From the Source" must double the CURRENT (already-modified) stats, not the base
  it("'From the Source' doubles an aura-modified target's current ATK/DEF, not just its base", () => {
    const s = build({
      board: [
        [0, mk("tgt", { cardId: "MJG-0w0", atk: 3, def: 4, tribes: ["Furry"] })], // furryLord: +1 ATK/DEF per other Furry
        [0, mk("f2", { tribes: ["Furry"] })],
      ],
    });
    expect(M.atkOf(s, "tgt")).toBe(4); // 3 base + 1 aura
    expect(M.defOf(s, "tgt")).toBe(5); // 4 base + 1 aura
    const out = E.runEffect(s, getScript("MJG-32歳", "bottom")!, { controller: 0, self: "self", targets: ["tgt"] });
    expect(M.atkOf(out, "tgt")).toBe(8); // double the current 4 — NOT 2×3 base + 1 aura = 7
    expect(M.defOf(out, "tgt")).toBe(10); // double the current 5 — NOT 2×4 base + 1 aura = 9
  });
});
