import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEffect, buildParsed, type Parsed } from "./psct.js";

const connOf = (p: Parsed, i: number) => p.steps[i]!.connector!;

describe("PSCT grammar (test_psct.py parity)", () => {
  it("R7 colon = activation condition", () => {
    const p = parseEffect(
      "If this is your first action this turn: You can Special Summon this card, then draw 1 card.",
    );
    expect(p.activation).toBe("If this is your first action this turn");
    expect(connOf(p, 1).kind).toBe("then");
    expect(connOf(p, 1).dependent).toBe(true);
    expect(connOf(p, 1).can_respond_between).toBe(true);
  });

  it("R16 'and' + ';' chain -> 3 steps", () => {
    const p = parseEffect(
      "Discard this card and target a character; Place it on the bottom of the deck.",
    );
    expect(p.step_count).toBe(3);
    expect(connOf(p, 1).kind).toBe("and");
    expect(connOf(p, 1).can_respond_between).toBe(false);
  });

  it("R22 if you do = simultaneous dependent, no response", () => {
    const p = parseEffect("Discard 1 card, if you do, draw 1 card.");
    expect(connOf(p, 1).kind).toBe("if_you_do");
    expect(connOf(p, 1).can_respond_between).toBe(false);
  });

  it("R34 next/fullstop = independent, responsive", () => {
    const p = parseEffect("Discard 1 card. Draw 1 card.");
    expect(connOf(p, 1).kind).toBe("next");
    expect(connOf(p, 1).dependent).toBe(false);
    expect(connOf(p, 1).can_respond_between).toBe(true);
  });

  it("R37 also = independent simultaneous, no response", () => {
    const p = parseEffect("Discard 1 card, also draw 1 card.");
    expect(connOf(p, 1).kind).toBe("also");
    expect(connOf(p, 1).dependent).toBe(false);
    expect(connOf(p, 1).can_respond_between).toBe(false);
  });

  it("clause markers", () => {
    const p = parseEffect("(Once per turn) (Mandatory) Draw 1 card.");
    expect(p.flags["once_per_turn"]).toBe(true);
    expect(p.flags["mandatory"]).toBe(true);
  });

  it("decimal not split", () => {
    const p = parseEffect("Set its VALUE to 1.5 somehow.");
    expect(p.step_count).toBe(1);
  });
});

describe("full-corpus parity with base_set_parsed.json", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  type Ab = { text?: string; parsed?: Parsed | null };
  type Card = { id: string; abilities: Ab[] };

  const base = JSON.parse(readFileSync(join(here, "../../base_set.json"), "utf-8")) as Card[];
  const ref = JSON.parse(readFileSync(join(here, "../../base_set_parsed.json"), "utf-8")) as Card[];
  const ours = buildParsed(JSON.parse(JSON.stringify(base)) as Card[]);

  it("same card count", () => expect(ours.length).toBe(ref.length));

  it("every ability's parsed tree matches the Python reference", () => {
    const mismatches: string[] = [];
    for (let i = 0; i < ref.length; i++) {
      const rc = ref[i]!;
      const oc = ours[i]!;
      for (let j = 0; j < rc.abilities.length; j++) {
        const a = JSON.stringify(oc.abilities[j]?.parsed ?? null);
        const b = JSON.stringify(rc.abilities[j]?.parsed ?? null);
        if (a !== b) mismatches.push(`${rc.id} ability[${j}]`);
      }
    }
    if (mismatches.length) {
      console.error(`PSCT parity mismatches (${mismatches.length}):`, mismatches.slice(0, 20));
    }
    expect(mismatches).toEqual([]);
  });
});
