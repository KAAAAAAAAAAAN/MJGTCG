import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as RU from "./rules.js";
import type { Ability } from "./rules.js";

const here = dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(
  readFileSync(join(here, "../../base_set_parsed.json"), "utf-8"),
) as { id: string; abilities: Ability[] }[];

const PIDS = [0, 1, 2, 3]; // clockwise seating

describe("Ruling 1: anticlockwise relative to activator", () => {
  it("activator first", () => expect(RU.seatOrder(PIDS, 2)[0]).toBe(2));
  it("anticlockwise from 2", () => expect(RU.seatOrder(PIDS, 2)).toEqual([2, 1, 0, 3]));
  it("2p strict alternation", () => {
    expect(RU.seatOrder([0, 1], 0)).toEqual([0, 1]);
    expect(RU.seatOrder([0, 1], 1)).toEqual([1, 0]);
  });
  it("indeterminate -> turn player", () =>
    expect(RU.priorityAfter(PIDS, null, 3)).toEqual([3, 2, 1, 0]));
});

describe("Ruling 2: only (At any time) actively chainable", () => {
  const quick = cards.flatMap((c) => c.abilities).filter((a) => RU.canActivelyChain(a));
  it("some quick effects exist", () => expect(quick.length).toBeGreaterThan(0));
  it("all quick are (At any time)", () =>
    expect(quick.every((a) => a.parsed?.flags?.["at_any_time"])).toBe(true));
  const nonq = cards
    .flatMap((c) => c.abilities)
    .filter((a) => a.parsed && !a.parsed.flags?.["at_any_time"]);
  it("non-AAT is trigger only", () => expect(nonq.every((a) => RU.isTriggerOnly(a))).toBe(true));
});

describe("Ruling 5: SEGOC ordering", () => {
  const trg: RU.Trigger[] = [
    { player: 1, id: "a" },
    { player: 3, id: "b" },
    { player: 0, id: "c" },
    { player: 1, id: "d" },
  ];
  const order = RU.orderSimultaneousTriggers(trg, PIDS, 0);
  const seq = order.map((i) => trg[i]!.player);
  it("turn player triggers first", () => expect(seq[0]).toBe(0));
  it("anticlockwise after (stable)", () => expect(seq).toEqual([0, 3, 1, 1]));
});

describe("Ruling 3: KAN", () => {
  it("declaration not a window", () => expect(RU.kanOpensResponseWindow()).toBe(false));
  const trigs = RU.kanResolutionTriggers({ kan: true, opponent_drew: true });
  it("when_you_kan trigger", () => expect(trigs).toContain("when_you_kan"));
  it("opponent draw trigger", () => expect(trigs).toContain("when_opponent_draws"));
});

describe("Ruling 4: deck access", () => {
  it("bare deck = base", () =>
    expect(RU.resolveDeckTarget("search the Deck for a card")).toBe("base"));
  it("named faith = faith", () =>
    expect(RU.resolveDeckTarget("add 1 card from your Faith Deck")).toBe("faith"));
  it("faith locked pre-meld", () => expect(RU.faithDeckAccessible({ afterMeld: false })).toBe(false));
  it("faith open post-meld", () => expect(RU.faithDeckAccessible({ afterMeld: true })).toBe(true));
  it("faith open if required", () =>
    expect(RU.faithDeckAccessible({ afterMeld: false, effectRequires: true })).toBe(true));
});

describe("Turn order: anticlockwise, same direction as priority", () => {
  it("next anticlockwise", () => expect(RU.nextSeatAnticlockwise([0, 1, 2, 3], 0)).toBe(3));
  it("wraps anticlockwise", () => expect(RU.nextSeatAnticlockwise([0, 1, 2, 3], 3)).toBe(2));
  it("skips eliminated", () =>
    expect(RU.nextSeatAnticlockwise([0, 1, 2, 3], 0, [0, 1, 2])).toBe(2));
  it("matches priority dir", () =>
    expect(RU.nextSeatAnticlockwise([0, 1, 2, 3], 2)).toBe(RU.seatOrder([0, 1, 2, 3], 2)[1]));
});

describe("Once-per-X scope detection & enforcement", () => {
  const ab = (flags?: Record<string, boolean>, clauses?: string[]): Ability => ({
    parsed: { flags: flags ?? {}, clauses: clauses ?? [] },
  });
  const opt = ab({ once_per_turn: true });
  const opg = ab(undefined, ["Once per game"]); // raw clause only, no flag
  const opp = ab(undefined, ["Once per player"]); // raw clause only, no flag
  const free = ab({ at_any_time: true });

  it("flag turn", () => expect(RU.onceScope(opt)).toBe("once_per_turn"));
  it("raw game", () => expect(RU.onceScope(opg)).toBe("once_per_game"));
  it("raw player", () => expect(RU.onceScope(opp)).toBe("once_per_player"));
  it("unlimited none", () => expect(RU.onceScope(free)).toBeNull());

  it("once_per_turn: first ok, second blocked, reset reopens", () => {
    let u: RU.UsageLedger = {};
    expect(RU.canActivateOnce(opt, "X", 0, u)).toBe(true);
    u = RU.recordUse(opt, "X", 0, u);
    expect(RU.canActivateOnce(opt, "X", 0, u)).toBe(false);
    const u2 = RU.resetTurnUsage(u);
    expect(RU.canActivateOnce(opt, "X", 0, u2)).toBe(true);
  });

  it("once_per_game: persists across turn reset", () => {
    let g: RU.UsageLedger = {};
    g = RU.recordUse(opg, "G", 0, g);
    expect(RU.canActivateOnce(opg, "G", 0, g)).toBe(false);
    expect(RU.canActivateOnce(opg, "G", 0, RU.resetTurnUsage(g))).toBe(false);
  });

  it("once_per_player: per-seat, not global", () => {
    let pp: RU.UsageLedger = {};
    pp = RU.recordUse(opp, "P", 0, pp);
    expect(RU.canActivateOnce(opp, "P", 0, pp)).toBe(false);
    expect(RU.canActivateOnce(opp, "P", 1, pp)).toBe(true);
  });

  it("unlimited never blocks; recordUse is a no-op", () =>
    expect(RU.canActivateOnce(free, "F", 0, RU.recordUse(free, "F", 0, {}))).toBe(true));
});
