import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./reducer.js";
import * as E from "./effects.js";
import { collectEndOfTurnTriggers, collectTriggers } from "./triggers.js";
import { CARD_TRIGGERS } from "./card-scripts.js";

const { reduce: R, ActionType: AT, Phase: Ph, player, replace } = M;
const here = dirname(fileURLToPath(import.meta.url));
type Card = { id: string; abilities: { role?: string; text?: string }[] };
const baseSet = JSON.parse(readFileSync(join(here, "../../base_set.json"), "utf-8")) as Card[];
const byId = new Map(baseSet.map((c) => [c.id, c]));

beforeAll(() => {
  M.setEffectResolver(E.resolveChainLink);
  M.setTriggerCollector(collectTriggers);
});

// place a crafted instance on a hand/board
function place(
  s: M.GameState, where: "hand" | "board", pid: number,
  iid: string, cardId: string, value: number,
): M.GameState {
  const ci: M.CardInstance = {
    iid, cardId, atk: 0, def: 0, value, tribes: [], faceDown: false,
    tapped: false, counters: {}, overlays: [], battles: 0, mods: [],
  };
  s = replace(s, { instances: { ...s.instances, [iid]: ci } });
  return replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, [where]: [...p[where], iid] } : p)) });
}

// place a Sprout (MJG-014) on a player's board
function placeSprout(s: M.GameState, pid: number, iid: string): M.GameState {
  const ci: M.CardInstance = {
    iid, cardId: "MJG-014", atk: 0, def: 7, value: 7, tribes: [], faceDown: false,
    tapped: false, counters: {}, overlays: [], battles: 0, mods: [],
  };
  s = replace(s, { instances: { ...s.instances, [iid]: ci } });
  return replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, board: [...p.board, iid] } : p)) });
}

describe("trigger registry integrity", () => {
  it("every CARD_TRIGGERS key maps to a real ability with text", () => {
    const bad: string[] = [];
    for (const key of Object.keys(CARD_TRIGGERS)) {
      const [id, role] = key.split(":");
      const card = byId.get(id!);
      if (!card || !card.abilities.some((a) => a.role === role && (a.text ?? "").trim())) bad.push(key);
    }
    expect(bad).toEqual([]);
  });
});

describe("end-of-turn triggers -> batch -> chain", () => {
  it("collects a Sprout's end-of-turn trigger and resolves it (draw 1)", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 20 });
    s = R(s, { type: AT.DRAW_RESOLVES }); // p0's turn, MAIN
    s = placeSprout(s, 0, "spr0");
    const trigs = collectEndOfTurnTriggers(s, 0);
    expect(trigs.length).toBe(1);
    expect(trigs[0]!.script).toEqual({ cardId: "MJG-014", role: "bottom", self: "spr0" });

    const h0 = player(s, 0).hand.length;
    s = R(s, { type: AT.OPEN_TRIGGER_BATCH, player: 0, triggers: trigs });
    expect(s.phase).toBe(Ph.RESPONSE_WINDOW);
    s = R(s, { type: AT.RESOLVE_CHAIN });
    expect(player(s, 0).hand.length).toBe(h0 + 1); // Sprout drew 1
  });

  it("SEGOC: end-of-turn triggers from both players both resolve (turn player first)", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 20 });
    s = R(s, { type: AT.DRAW_RESOLVES }); // turn player 0
    s = placeSprout(s, 0, "spr0");
    s = placeSprout(s, 1, "spr1");
    const trigs = collectEndOfTurnTriggers(s, 0);
    expect(trigs.length).toBe(2);

    const h0 = player(s, 0).hand.length;
    const h1 = player(s, 1).hand.length;
    s = R(s, { type: AT.OPEN_TRIGGER_BATCH, player: 0, triggers: trigs });
    // chain placed turn-player-first (anticlockwise): [p0, p1]
    expect(s.chain.map((l) => l.sourcePlayer)).toEqual([0, 1]);
    s = R(s, { type: AT.RESOLVE_CHAIN });
    expect(player(s, 0).hand.length).toBe(h0 + 1);
    expect(player(s, 1).hand.length).toBe(h1 + 1);
  });

  it("no end-of-turn triggers when none are on board", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 20 });
    s = R(s, { type: AT.DRAW_RESOLVES });
    expect(collectEndOfTurnTriggers(s, 0)).toEqual([]);
  });
});

describe("summon triggers (event emission -> PROCESS_EVENTS)", () => {
  it("normal summon emits a summon event", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 20, cardRegistry: baseSet });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = place(s, "hand", 0, "kagy", "MJG-C15", 5);
    s = R(s, { type: AT.NORMAL_SUMMON, player: 0, summonId: "kagy" });
    expect(s.events.filter((e) => e.kind !== "draw")).toEqual([{ kind: "summon", iid: "kagy", player: 0 }]);
  });

  it("Ice Princess fires on summon and discards all VALUE<=4 (itself survives)", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 20, cardRegistry: baseSet });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = place(s, "hand", 0, "kagy", "MJG-C15", 5);
    s = place(s, "board", 0, "lo", "", 3); // VALUE 3 -> discarded
    s = place(s, "board", 1, "hi", "", 7); // VALUE 7 -> survives

    s = R(s, { type: AT.NORMAL_SUMMON, player: 0, summonId: "kagy" }); // -> ACTION_ANNOUNCED
    s = R(s, { type: AT.RESOLVE_CHAIN }); // close the summon window -> MAIN
    expect(s.phase).toBe(Ph.MAIN_PHASE);

    s = R(s, { type: AT.PROCESS_EVENTS }); // collect Ice Princess trigger -> RESPONSE_WINDOW
    expect(s.phase).toBe(Ph.RESPONSE_WINDOW);
    expect(s.chain.length).toBe(1);
    expect(s.events).toEqual([]); // drained

    s = R(s, { type: AT.RESOLVE_CHAIN }); // Ice Princess resolves
    // the wipe is QUEUED (mass discards land one by one; the session drives the
    // windows) — drain it manually at this reducer-level test
    for (const g of s.pendingEffectDiscards) for (const iid of g.iids) s = E.applyIntent(s, { kind: "discard", iid }, g.by, g.source).state;
    s = M.replace(s, { pendingEffectDiscards: [] });
    expect(player(s, 0).board).toContain("kagy"); // VALUE 5 survives
    expect(player(s, 0).board).not.toContain("lo"); // VALUE 3 discarded
    expect(player(s, 1).board).toContain("hi"); // VALUE 7 survives
    expect(s.discard).toContain("lo");
  });

  it("Swordslut 'Banzai!' fires after a battle-discard: +2/-2 and can attack again", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 20, cardRegistry: baseSet });
    s = R(s, { type: AT.DRAW_RESOLVES });
    const craft = (iid: string, cardId: string, atk: number, def: number): M.CardInstance => ({
      iid, cardId, atk, def, value: 5, tribes: [], faceDown: false, tapped: false,
      counters: {}, overlays: [], battles: 0, mods: [],
    });
    s = replace(s, {
      instances: { ...s.instances, sw: craft("sw", "MJG-027", 3, 7), pr: craft("pr", "", 1, 1) },
    });
    s = replace(s, {
      players: s.players.map((p) =>
        p.pid === 0 ? { ...p, board: [...p.board, "sw"] } : { ...p, board: [...p.board, "pr"] },
      ),
    });
    // Swordslut (3/7) attacks prey (1/1): prey discarded, Swordslut survives + taps
    s = R(s, { type: AT.DECLARE_BATTLE, attackerId: "sw", targetId: "pr" });
    s = R(s, { type: AT.RESOLVE_CHAIN });
    expect(player(s, 1).board).not.toContain("pr");
    expect(M.inst(s, "sw").tapped).toBe(true);
    // a battle discard emits the generic "discarded" event, the discarder-scoped
    // battleDiscard event, and the generic "battle" event ("after this card battles")
    expect(s.events.filter((e) => e.kind !== "draw")).toEqual([
      { kind: "discarded", iid: "pr", player: 1 },
      { kind: "battleDiscard", discarder: "sw", discarded: "pr", player: 0 },
      { kind: "battle", atk: "sw", def: "pr" },
    ]);

    s = R(s, { type: AT.PROCESS_EVENTS }); // -> Banzai trigger on the stack
    expect(s.phase).toBe(Ph.RESPONSE_WINDOW);
    s = R(s, { type: AT.RESOLVE_CHAIN });
    expect(M.atkOf(s, "sw")).toBe(5); // 3 + 2
    expect(M.defOf(s, "sw")).toBe(5); // 7 - 2
    expect(M.inst(s, "sw").tapped).toBe(false); // can attack again
  });

  it("PROCESS_EVENTS with no matching trigger drains events and stays in MAIN", () => {
    let s = M.newGame({ players: [0, 1], mainDeck: 20, cardRegistry: baseSet });
    s = R(s, { type: AT.DRAW_RESOLVES });
    s = place(s, "hand", 0, "plain", "MJG-011", 1); // Haruna: no summon trigger
    s = R(s, { type: AT.NORMAL_SUMMON, player: 0, summonId: "plain" });
    s = R(s, { type: AT.RESOLVE_CHAIN });
    s = R(s, { type: AT.PROCESS_EVENTS });
    expect(s.phase).toBe(Ph.MAIN_PHASE);
    expect(s.events).toEqual([]);
  });
});
