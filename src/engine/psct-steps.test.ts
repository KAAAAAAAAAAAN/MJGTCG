import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CARD_SCRIPTS, CARD_TRIGGERS, CARD_STEPS } from "./card-scripts.js";

/**
 * Strict-PSCT guard: an ability whose text has a RESPONDABLE inner connector (a
 * `then`/`;` or `.`/`next` between two steps — R14/R33) must resolve step-by-step so
 * a response window can open there. This test pins which implemented abilities have
 * such a boundary and asserts each is either modeled (CARD_STEPS) or explicitly folds
 * into the activation window. A new such card fails here until it's handled — so a
 * within-ability window can't be silently dropped.
 */
const here = dirname(fileURLToPath(import.meta.url));
type Parsed = { choice?: boolean; steps?: { connector?: { can_respond_between?: boolean } }[] } | null;
const cards = JSON.parse(readFileSync(join(here, "../../base_set_parsed.json"), "utf-8")) as {
  id: string;
  abilities: { role?: string; parsed?: Parsed }[];
}[];

const byKey = new Map<string, Parsed>();
for (const c of cards) for (const a of c.abilities) if (a.role) byKey.set(`${c.id}:${a.role}`, a.parsed ?? null);

/** True if the parse has a respondable connector BEFORE a step other than step 0. */
function hasInnerRespondable(p: Parsed): boolean {
  if (!p || p.choice) return false;
  return (p.steps ?? []).some((s, i) => i > 0 && s.connector?.can_respond_between === true);
}

// Frozen: implemented abilities whose PSCT parse has a respondable inner connector.
const PARSE_INNER_RESPONDABLE = new Set([
  "AS4-PIN:bottom", "AS4-PIN:top", "BAK-YOU:bottom", "FAT-009:top", "HTTP-404:top", "JONG-030:bottom", "JONG-030:top",
  "MJG-HAT:top", "MOON-001:top", "MTG-001:top",
  "MJG-001:top", "MJG-006:bottom",
  "MJG-012:bottom", "MJG-018:bottom", "MJG-021:bottom", "MJG-021:top", "MJG-022:bottom",
  "MJG-026:top", "MJG-028:top", "MJG-035:bottom", "MJG-039:top", "MJG-044:top", "MJG-045:top",
  "MJG-046:top", "MJG-047:top", "MJG-32歳:bottom", "MJG-333:top", "MJG-77*:top", "MJG-C17:top", "MJG-C17:bottom", "MJG-C31:top",
  "MJG-C33:top", "MJG-M02:top", "MJG-M03:bottom", "MJG-M03:top", "MJG-M04:bottom", "MJG-M06:top",
  "MJG-M10:bottom", "MJG-M10:top", "MJG-M11:bottom", "MJG-M12:top", "MJG-M13:bottom",
  "MJG-M13:top", "MJG-M14:bottom", "MJG-M14:top", "MJG-M19:bottom", "MJG-M19:top", "MJG-M21:top",
  "MJG-C05:bottom", "MJG-C07:bottom", "MJG-C09:bottom", "MJG-C10:bottom", "MJG-C11:bottom", "MJG-C28:bottom", "MJG-C32:top", "MJG-C34:top", "MJG-M08:top", "MJG-036:top", "MJG-036:bottom", "MJG-048:bottom", "MJG-M22:bottom", "MJG-M23:bottom", "MJG-ZERO:bottom", "MJG-C23:top", "MJG-C25:top", "MJG-C24:top", "MJG-M05:top", "MJG-C18:bottom", "MJG-C29:bottom", "NYA-001:top", "SHA-001:top", "SOA-C02:top",
]);

// Of those, the ones where the respondable connector immediately follows leading
// targeting/cost, so the window IS the activation window (no within-resolution
// window): they resolve atomically, with no CARD_STEPS entry.
const FOLDED_INTO_ACTIVATION = new Set([
  "BAK-YOU:bottom", "MJG-006:bottom", "MJG-018:bottom", "MJG-035:bottom", "MJG-32歳:bottom", "MJG-C33:top", "NYA-001:top", "SHA-001:top",
  // JONG-030's `;` follows the leading target (activation window); its only other
  // respondable boundary precedes the trailing "(Returning ...)" parenthetical,
  // which is informational — no state change, so no window is needed.
  "JONG-030:bottom",
  // MJG-039 succ: the leading `;` folds into the activation window; the repeat
  // iterations run as one session-driven loop WITHOUT inner response windows
  // (documented simplification of the per-repeat `then`).
  "MJG-039:top",
  // MJG-045 Ear Rape: the only respondable boundary precedes the trailing
  // "(Cannot attack or use ACTIVE effects.)" parenthetical — informational.
  "MJG-045:top",
  // MJG-C28 Tactical Suppression: the stun is one step; the only respondable boundary
  // precedes the same trailing "(Cannot attack or use ACTIVE effects.)" parenthetical.
  "MJG-C28:bottom",
  // MJG-046 Party Hard: same — the trailing "(Including their own.)" is informational.
  "MJG-046:top",
  // MJG-047 Useless Censors: the `;` follows the leading reveal+target (the
  // activation window); the flip is the entire resolution.
  "MJG-047:top",
  // MJG-C17 Treasurer: the reveal of the top 2 folds into the activation window; the
  // branch (add / discard / nothing) is one resolution and the only respondable boundary
  // precedes the trailing "(Shuffle revealed cards back.)" cleanup parenthetical.
  "MJG-C17:bottom",
  // MJG-M04 Target Ron: the `;` follows the leading target; the other boundary
  // precedes the "(You cannot activate ...)" parenthetical — informational.
  "MJG-M04:bottom",
  // MJG-C32 LTG: the `;` follows the leading target (activation window); the opponent's
  // board-discard and the Special Summon are one `and`-joined execution step.
  "MJG-C32:top",
  // MJG-M08 Candy: the `;` follows the leading target (activation window); gaining control
  // and the Special Summon are one `and`-joined execution step.
  "MJG-M08:top",
  // MJG-036 Sacred Enjou: the `;` follows the leading target (activation window); gaining
  // control and scheduling the end-of-turn discard are one execution step.
  "MJG-036:bottom",
  // MJG-048 Snake Bite: target + give a poison counter is one step; the only respondable
  // boundary precedes the informational "During their next turn …" delayed clause.
  "MJG-048:bottom",
  // MJG-M11 Matchmaker: the `;` follows the leading target (activation window);
  // the bond is the single execution step.
  "MJG-M11:bottom",
  // MJG-M13 Trap Trick / Gay ERP: the `;` follows the leading target (activation
  // window); the flip + (SS / swap) are `and`-joined into one execution step.
  "MJG-M13:top", "MJG-M13:bottom",
  // MJG-M14 CAM ON MJG / SCOR SOM FACKIN MANGANS: the `;` follows the leading target
  // (activation window); the rest (`and then` SS / the single meld) is one step.
  "MJG-M14:top", "MJG-M14:bottom",
  // MJG-M19 Tile Efficiency: SS + force-meld are `and`-joined (one step); the only
  // respondable boundary precedes the informational "They do not draw …" clause.
  "MJG-M19:top",
  // MJG-M19 We Gottem: the `;` follows the leading target+reveal (activation window);
  // adding the [Cunny]/[Shota] cards is the single execution step.
  "MJG-M19:bottom",
  // MJG-C07 Diabolus ex Machina: draw the whole deck is the single execution; the only
  // respondable boundary precedes the delayed "at the end of your turn, shuffle" clause.
  "MJG-C07:bottom",
  // MJG-C09 Honest Gamble / MJG-C10 Honester Gamble / MJG-C11 Honestest Gamble: the
  // `;`/reveals are the activation; the compare+effect is one step; the only respondable
  // boundary precedes the informational "(Nothing happens in ties.)".
  // (MJG-C12 Double or Nothing folds into activation the same way, but its parse is a
  // single step with no inner connector, so it isn't in PARSE_INNER_RESPONDABLE.)
  "MJG-C09:bottom", "MJG-C10:bottom", "MJG-C11:bottom",
  // MJG-M21 BAAAANG: the `;` follows the leading target (activation window); the two
  // discards ("discard your hand, and then they discard theirs") are one `and` step.
  "MJG-M21:top",
  // MJG-M22 Secret Rumors: the target+move are `and`-joined; the only respondable
  // boundary precedes the informational deferred-flip ("at the start of … next turn").
  "MJG-M22:bottom",
  // MJG-M23 Buying gf: the `;` follows the leading target (activation window); the
  // give + take-control are `and`-joined into one execution step.
  "MJG-M23:bottom",
  // MJG-ZERO Geass: the `;` follows the leading target (activation window); gaining control
  // of their next turn is the single execution step. The only other respondable boundary
  // precedes the trailing "This ACTIVE can only be used ... once per game" restriction clause.
  "MJG-ZERO:bottom",
  // MJG-C23 Summon - Berserker: the overlay-Summon is the single execution step; the
  // respondable boundary precedes the continuous "gains the ATK of all overlaid cards" clause,
  // which is a passive aura (no discrete resolution), so it folds into the activation.
  "MJG-C23:top",
  // MJG-C25 Twin Personality: as MJG-C23 — the overlay-Summon is the single step; the
  // "gains the ATK, DEF, and abilities of all overlaid cards" clause is a continuous passive.
  "MJG-C25:top",
  // MJG-C24 Summon - Caster: as MJG-C23/C25 — the overlay-Summon is the single step; the
  // "gains the DEF of all overlaid cards" clause is a continuous passive aura.
  "MJG-C24:top",
  // MJG-C18 De-Fusion: the `;`/then follows the leading "Discard this card" cost (the
  // activation window); Special Summoning the chosen Blue-Eyes White Dragon is one execution.
  "MJG-C18:bottom",
  // MJG-C29 Noir Attack: the discard is one execution; the only respondable boundary precedes
  // the trailing "(In any order, on any board, including your own ...)" informational clause.
  "MJG-C29:bottom",
]);

describe("strict-PSCT step coverage", () => {
  const implemented = new Set([...Object.keys(CARD_SCRIPTS), ...Object.keys(CARD_TRIGGERS)]);

  it("the set of implemented abilities with a respondable inner connector is frozen", () => {
    const actual = [...implemented].filter((k) => hasInnerRespondable(byKey.get(k) ?? null)).sort();
    expect(actual).toEqual([...PARSE_INNER_RESPONDABLE].sort());
  });

  it("every CARD_STEPS list is structural: step 0 has no window, and SOME later step does", () => {
    for (const [key, steps] of Object.entries(CARD_STEPS)) {
      expect(steps.length, `${key} step list must be multi-step`).toBeGreaterThan(1);
      expect(steps[0]!.respondBefore, `${key} step 0 must not open a window`).toBe(false);
      // a later step may be `and`-joined (no window, e.g. JONG-030's give), but at
      // least one respondable boundary is what justifies splitting into steps
      expect(steps.some((s, i) => i > 0 && s.respondBefore), `${key} needs a respondable inner step`).toBe(true);
      expect(PARSE_INNER_RESPONDABLE.has(key), `${key} has a CARD_STEPS list but no inner-respondable parse`).toBe(true);
    }
  });

  it("every inner-respondable ability is either modeled (CARD_STEPS) or folded into activation", () => {
    for (const key of PARSE_INNER_RESPONDABLE) {
      const modeled = key in CARD_STEPS;
      const folded = FOLDED_INTO_ACTIVATION.has(key);
      expect(modeled || folded, `${key}: add a CARD_STEPS list or list it in FOLDED_INTO_ACTIVATION`).toBe(true);
      expect(modeled && folded, `${key}: cannot be both modeled and folded`).toBe(false);
    }
  });
});
