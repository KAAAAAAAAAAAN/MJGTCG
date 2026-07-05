import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./reducer.js";
import { legalActions, canRespond } from "./legal.js";

const { reduce: R, ActionType: AT, Phase: Ph, replace } = M;
const here = dirname(fileURLToPath(import.meta.url));
const baseSet = JSON.parse(readFileSync(join(here, "../../base_set.json"), "utf-8")) as M.Card[];

const mk = (iid: string, cardId = "", over: Partial<M.CardInstance> = {}): M.CardInstance => ({
  iid, cardId, atk: 1, def: 1, value: 1, tribes: [], faceDown: false,
  tapped: false, counters: {}, overlays: [], battles: 0, mods: [], ...over,
});
function place(s: M.GameState, where: "hand" | "board", pid: number, ci: M.CardInstance): M.GameState {
  s = replace(s, { instances: { ...s.instances, [ci.iid]: ci } });
  return replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, [where]: [...p[where], ci.iid] } : p)) });
}
/** seat-0 game already in MAIN_PHASE (empty start hand, then 1 opaque drawn). */
function main(): M.GameState {
  let s = M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0, cardRegistry: baseSet });
  return R(s, { type: AT.DRAW_RESOLVES });
}
const kinds = (s: M.GameState, seat: number) => legalActions(s, seat).map((a) => a.kind);

describe("legalActions — generic", () => {
  it("draw only for the active player in TURN_START_DRAW", () => {
    const s = M.newGame({ players: [0, 1], mainDeck: 20, startingHand: 0 });
    expect(kinds(s, 0)).toContain("draw");
    expect(legalActions(s, 1)).toEqual([]); // not their turn, no anytime cards
  });

  it("MAIN_PHASE offers end-turn and normal-summon for hand cards (not Faith)", () => {
    let s = main();
    s = place(s, "hand", 0, mk("faith", "MJG-014")); // Faith card -> not normal-summonable
    const acts = legalActions(s, 0);
    expect(acts.some((a) => a.kind === "endTurn")).toBe(true);
    const summonIids = acts.filter((a) => a.kind === "normalSummon").map((a) => (a as { iid: string }).iid);
    expect(summonIids.length).toBeGreaterThan(0); // the opaque drawn card
    expect(summonIids).not.toContain("faith");
  });

  it("no normal-summon once you've summoned this turn", () => {
    let s = main();
    s = replace(s, { players: s.players.map((p) => (p.pid === 0 ? { ...p, summonedThisTurn: true } : p)) });
    expect(kinds(s, 0)).not.toContain("normalSummon");
  });

  it("attack offered for an untapped board card when an opponent target exists", () => {
    let s = main();
    s = place(s, "board", 0, mk("att"));
    s = place(s, "board", 1, mk("foe"));
    expect(legalActions(s, 0).some((a) => a.kind === "attack" && (a as { iid: string }).iid === "att")).toBe(true);
  });

  it("no attack when tapped, or when no opponent target exists", () => {
    let tapped = main();
    tapped = place(tapped, "board", 0, mk("att", "", { tapped: true }));
    tapped = place(tapped, "board", 1, mk("foe"));
    expect(kinds(tapped, 0)).not.toContain("attack");

    let lonely = main();
    lonely = place(lonely, "board", 0, mk("att")); // no opponent board card
    expect(kinds(lonely, 0)).not.toContain("attack");
  });

  it("vanilla cards offer no activate actions (negative assumption)", () => {
    let s = main();
    s = place(s, "board", 0, mk("v", "MJG-011")); // Haruna (vanilla, not in ACTIVATIONS)
    expect(kinds(s, 0)).not.toContain("activate");
  });

  it("meld offered only when 3 sources form a valid meld, and not after melding", () => {
    let s = main();
    s = place(s, "board", 0, mk("a", "", { value: 2 }));
    s = place(s, "board", 0, mk("b", "", { value: 3 }));
    expect(kinds(s, 0)).not.toContain("meld"); // only 2 sources
    s = place(s, "board", 0, mk("c", "", { value: 7 })); // 2,3,7 -> no valid meld
    expect(kinds(s, 0)).not.toContain("meld");
    s = place(s, "board", 0, mk("d", "", { value: 4 })); // now 2,3,4 is a sequence
    expect(kinds(s, 0)).toContain("meld");
    // already melded this turn -> not offered
    const melded = replace(s, { players: s.players.map((p) => (p.pid === 0 ? { ...p, meldedThisTurn: true } : p)) });
    expect(kinds(melded, 0)).not.toContain("meld");
  });

  it("a non-active player has no actions in the opponent's MAIN phase", () => {
    let s = main();
    s = place(s, "board", 1, mk("x"));
    expect(legalActions(s, 1)).toEqual([]);
  });
});

describe("activation conditions (registered specs)", () => {
  const activateIids = (s: M.GameState, seat: number) =>
    legalActions(s, seat).filter((a) => a.kind === "activate").map((a) => (a as { iid: string }).iid);

  it("SMMR is activatable only with exactly 3 characters on your board", () => {
    // not 3 -> no activate
    let s = main();
    s = place(s, "hand", 0, mk("smmr", "MJG-M16"));
    expect(activateIids(s, 0)).not.toContain("smmr");
    // exactly 3 board chars -> activatable
    for (const id of ["b1", "b2", "b3"]) s = place(s, "board", 0, mk(id));
    expect(activateIids(s, 0)).toContain("smmr");
  });

  it("p*n*s is activatable only with the strictly biggest hand", () => {
    let s = main(); // seat0 hand has 1 (the drawn opaque)
    s = place(s, "hand", 0, mk("pen", "MJG-041")); // seat0 hand=2, seat1 hand=0
    expect(activateIids(s, 0)).toContain("pen");
    s = place(s, "hand", 1, mk("x1"));
    s = place(s, "hand", 1, mk("x2")); // seat1 hand=2, tie -> not "biggest (not tied)"
    expect(activateIids(s, 0)).not.toContain("pen");
  });

  it("ywnbaw7 needs 'What are the odds...' on a board", () => {
    let s = main();
    s = place(s, "hand", 0, mk("kyap", "MJG-C07"));
    expect(activateIids(s, 0)).not.toContain("kyap");
    s = place(s, "board", 1, mk("hisa", "MJG-C08"));
    expect(activateIids(s, 0)).toContain("kyap");
  });

  it("Nyagger top is activatable only as your first action this turn", () => {
    let s = main();
    s = place(s, "hand", 0, mk("ny", "MJG-001"));
    expect(activateIids(s, 0)).toContain("ny"); // fresh turn -> first action
    // having acted this turn -> no longer the first action
    const acted = replace(s, { players: s.players.map((p) => (p.pid === 0 ? { ...p, actedThisTurn: true } : p)) });
    expect(activateIids(acted, 0)).not.toContain("ny");
  });

  it("a tapped board card no longer offers its Active", () => {
    let s = main();
    s = place(s, "board", 0, mk("ny", "MJG-001")); // untapped Nyagger
    expect(activateIids(s, 0)).toContain("ny");
    s = place(s, "board", 0, mk("ny2", "MJG-001", { tapped: true }));
    expect(activateIids(s, 0)).not.toContain("ny2");
  });
});

describe("canRespond", () => {
  it("false outside a window", () => expect(canRespond(main(), 0)).toBe(false));
  it("false in a window with no (At any time) cards registered", () => {
    const s = replace(main(), { phase: Ph.ACTION_ANNOUNCED });
    expect(canRespond(s, 0)).toBe(false);
  });
});
