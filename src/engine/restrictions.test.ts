import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./reducer.js";
import { checkRestrictions, RESTRICTIONS, REVEAL_EFFECTS } from "./restrictions.js";
import { applyIntent } from "./effects.js";
import { ACTIVATIONS } from "./legal.js";

const { reduce: R, ActionType: AT, Phase: Ph, replace } = M;
const here = dirname(fileURLToPath(import.meta.url));
type Card = { id: string; abilities: { role?: string; text?: string }[] };
const baseSet = JSON.parse(readFileSync(join(here, "../../base_set.json"), "utf-8")) as Card[];
const byId = new Map(baseSet.map((c) => [c.id, c]));

beforeAll(() => M.setRestrictionChecker(checkRestrictions));

const mk = (iid: string, over: Partial<M.CardInstance> = {}): M.CardInstance => ({
  iid, cardId: "", atk: 1, def: 1, value: 1, tribes: [], faceDown: false,
  tapped: false, counters: {}, overlays: [], battles: 0, mods: [], ...over,
});
function build(board: [number, M.CardInstance][]): M.GameState {
  let s = M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0 });
  for (const [, ci] of board) s = replace(s, { instances: { ...s.instances, [ci.iid]: ci } });
  for (const [pid, ci] of board)
    s = replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, board: [...p.board, ci.iid] } : p)) });
  return s;
}

describe("restriction registry integrity", () => {
  it("every RESTRICTIONS key maps to a real ability with text", () => {
    const bad: string[] = [];
    for (const key of Object.keys(RESTRICTIONS)) {
      const [id, role] = key.split(":");
      const card = byId.get(id!);
      if (!card || !card.abilities.some((a) => a.role === role && (a.text ?? "").trim())) bad.push(key);
    }
    expect(bad).toEqual([]);
  });

  it("REVEAL_EFFECTS is exactly the activatable abilities whose text reveals cards", () => {
    const fromData = Object.keys(ACTIVATIONS)
      .filter((k) => {
        // Koito "Easily Startled" NEGATES reveal effects; it doesn't reveal cards itself,
        // so it isn't a Malware-blockable reveal effect despite mentioning "reveal".
        if (k === "MJG-C31:top") return false;
        const [id, role] = k.split(":");
        const a = byId.get(id!)?.abilities.find((x) => x.role === role);
        return /reveal/i.test(a?.text ?? "");
      })
      .sort();
    expect([...REVEAL_EFFECTS].sort()).toEqual(fromData);
  });
});

describe("HTTP-404 'Malware'", () => {
  it("the controller cannot activate reveal effects; everyone else can", () => {
    const s = build([[1, mk("hax", { cardId: "HTTP-404", tribes: ["Schizo"] })]]); // on p1's board
    // p1 (the controller) is locked out of reveal effects...
    expect(checkRestrictions(s, { kind: "activate", player: 1, abilityType: "S", effectId: "MJG-002:top" })).toMatch(/Malware/);
    // ...but a non-reveal effect is fine, and another seat is unaffected
    expect(checkRestrictions(s, { kind: "activate", player: 1, abilityType: "S", effectId: "MJG-001:top" })).toBeNull();
    expect(checkRestrictions(s, { kind: "activate", player: 0, abilityType: "S", effectId: "MJG-002:top" })).toBeNull();
  });

  it("a face-down copy imposes no lock", () => {
    const s = build([[1, mk("hax", { cardId: "HTTP-404", tribes: ["Schizo"], faceDown: true })]]);
    expect(checkRestrictions(s, { kind: "activate", player: 1, abilityType: "S", effectId: "MJG-002:top" })).toBeNull();
  });

  it("cannotBeMelded: only a face-up board copy can't be a meld material", () => {
    const up = build([[0, mk("hax", { cardId: "HTTP-404", value: 4 })]]);
    expect(M.cannotBeMelded(up, "hax")).toBe(true);
    const fd = build([[0, mk("hax", { cardId: "HTTP-404", value: 4, faceDown: true })]]);
    expect(M.cannotBeMelded(fd, "hax")).toBe(false);
  });

  it("a meld using HTTP-404 as a material is rejected by reduce", () => {
    let s = build([
      [0, mk("hax", { cardId: "HTTP-404", value: 4 })],
      [0, mk("a", { value: 4 })],
      [0, mk("b", { value: 4 })],
    ]);
    s = replace(s, { phase: Ph.MAIN_PHASE });
    expect(() => R(s, { type: AT.DECLARE_MELD, player: 0, materials: ["hax", "a", "b"] })).toThrow(/Malware/);
  });
});

describe("KORO 'Iishanten Hell': opponents cannot meld", () => {
  it("blocks the opponent, allows the controller", () => {
    const s = build([[0, mk("koro", { cardId: "MJG-C03" })]]);
    expect(checkRestrictions(s, { kind: "meld", player: 1 })).toMatch(/cannot make melds/);
    expect(checkRestrictions(s, { kind: "meld", player: 0 })).toBeNull();
  });
  it("a face-down KORO imposes no lock", () => {
    const s = build([[0, mk("koro", { cardId: "MJG-C03", faceDown: true })]]);
    expect(checkRestrictions(s, { kind: "meld", player: 1 })).toBeNull();
  });
  it("rejects an opponent's MELD through reduce", () => {
    let s = build([[0, mk("koro", { cardId: "MJG-C03" })]]);
    s = replace(s, { activePlayer: 1, phase: Ph.MAIN_PHASE }); // p1's turn
    expect(() => R(s, { type: AT.MELD, player: 1, materials: ["a", "b", "c"] })).toThrow(/cannot make melds/);
  });
  it("also blocks an EFFECT meld (meldBoard) by an opponent — e.g. Copebots' Special Meld", () => {
    const s = build([
      [0, mk("koro", { cardId: "MJG-C03" })], // KORO on P0's board
      [1, mk("a", { value: 2 })], [1, mk("b", { value: 2 })], [1, mk("c", { value: 2 })], // P1's would-be materials
    ]);
    const { state, result } = applyIntent(s, { kind: "meldBoard", player: 1, materials: ["a", "b", "c"] }, 1, "");
    expect(result).toBeNull(); // the special meld fizzles instead of bypassing the lock
    expect(M.player(state, 1).meldZone.length).toBe(0); // nothing melded
    expect(state.log.some((l) => l.includes("Iishanten Hell"))).toBe(true);
  });
});

describe("Schizo locks (Housepet = SPELL, President = ACTIVE)", () => {
  it("SPELL lock blocks a player without a [Schizo], allows one with", () => {
    const s = build([[1, mk("yume", { cardId: "MJG-C09", tribes: ["Schizo"] })]]); // lock on p1's board
    expect(checkRestrictions(s, { kind: "activate", player: 0, abilityType: "S" })).toMatch(/Housepet/);
    expect(checkRestrictions(s, { kind: "activate", player: 0, abilityType: "A" })).toBeNull(); // not a SPELL
    expect(checkRestrictions(s, { kind: "activate", player: 1, abilityType: "S" })).toBeNull(); // p1 controls a Schizo (YUME)
  });
  it("ACTIVE lock blocks a player without a [Schizo]", () => {
    const s = build([[1, mk("kira", { cardId: "MJG-C11", tribes: ["Schizo"] })]]);
    expect(checkRestrictions(s, { kind: "activate", player: 0, abilityType: "A" })).toMatch(/President/);
    expect(checkRestrictions(s, { kind: "activate", player: 0, abilityType: "S" })).toBeNull();
  });
  it("controlling your own Schizo lifts the SPELL lock", () => {
    const s = build([
      [1, mk("yume", { cardId: "MJG-C09", tribes: ["Schizo"] })],
      [0, mk("myschizo", { tribes: ["Schizo"] })],
    ]);
    expect(checkRestrictions(s, { kind: "activate", player: 0, abilityType: "S" })).toBeNull();
  });

  it("rejects a SPELL activation through reduce, then allows it once a Schizo is controlled", () => {
    M.setRegistry({ SP: { type: "S", parsed: { flags: {} } } });
    let s = build([[1, mk("yume", { cardId: "MJG-C09", tribes: ["Schizo"] })]]);
    s = replace(s, { activePlayer: 0, phase: Ph.MAIN_PHASE });
    expect(() => R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "SP" })).toThrow(/Housepet/);
    // give p0 a Schizo -> now allowed
    s = build([
      [1, mk("yume", { cardId: "MJG-C09", tribes: ["Schizo"] })],
      [0, mk("s0", { tribes: ["Schizo"] })],
    ]);
    s = replace(s, { activePlayer: 0, phase: Ph.MAIN_PHASE });
    const out = R(s, { type: AT.PLAYER_ACTS, player: 0, effectId: "SP" });
    expect(out.phase).toBe(Ph.ACTION_ANNOUNCED);
  });
});
