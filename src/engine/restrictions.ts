/**
 * MJGTCG restriction / lock auras.
 *
 * Continuous passives that FORBID actions (rather than modify stats). The reducer
 * builds a RestrictionContext for a proposed action (meld / activate / attack) and
 * asks `checkRestrictions` whether any active lock forbids it; the first reason
 * found rejects the action.
 *
 * This slice covers clean action-blocks; negation auras that disable OTHER cards'
 * effects ("Take your meds", SOA, "Ya Boy") are a separate, trickier sub-slice.
 * Face-down lock sources are treated as not existing.
 */
import { isEffectNegated, tribesOf, abilityCardIds, isBrick, type GameState, type RestrictionContext } from "./reducer.js";
import type { Seat } from "./rules.js";

export type Restriction = (state: GameState, self: string, ctx: RestrictionContext) => string | null;

const ROLES = ["top", "bottom"] as const;
const isLive = (state: GameState, iid: string): boolean => !state.instances[iid]?.faceDown;
function controllerOf(state: GameState, iid: string): Seat | null {
  return state.players.find((p) => p.board.includes(iid))?.pid ?? null;
}
/** Does `pid` control a face-up [Schizo] on their board? */
function controlsSchizo(state: GameState, pid: Seat): boolean {
  const p = state.players.find((x) => x.pid === pid);
  // [Schizo] includes characters "considered" Schizo by Heaven's Gate (no [Type] tag).
  return !!p?.board.some((iid) => isLive(state, iid) && tribesOf(state, iid).includes("Schizo"));
}

/**
 * Implemented (player-activatable) abilities whose text "reveals" cards — what
 * "Malware" (HTTP-404) forbids its controller from activating. The parser does not
 * tag "reveal" reliably and the registry carries no text, so this set is curated;
 * `restrictions.test.ts` guards it against the card data (every ACTIVATIONS ability
 * with "reveal" in its text must appear here, and vice versa).
 */
export const REVEAL_EFFECTS = new Set([
  "MJG-002:top", "MJG-002:bottom", "FAT-009:bottom", "MJG-026:bottom", "MJG-047:top", "MJG-M02:bottom",
  "MJG-M19:bottom", "MJG-C03:bottom", "MJG-C06:bottom", "MJG-C09:bottom", "MJG-C10:bottom", "MJG-C11:bottom", "MJG-C12:bottom",
  "MJG-C17:bottom", "MJG-C23:bottom", "SHA-001:top", "MJG-117633:top",
]);

export const RESTRICTIONS: Record<string, Restriction> = {
  // The Hacker known as 4chan "Malware": this card's CONTROLLER ("you") cannot
  // activate effects that reveal cards (REVEAL_EFFECTS). Stick it on an opponent's
  // board (via BSoD) to lock down their reveal effects.
  "HTTP-404:bottom": (state, self, ctx) => {
    if (ctx.kind !== "activate" || !ctx.effectId || !REVEAL_EFFECTS.has(ctx.effectId)) return null;
    if (isEffectNegated(state, self)) return null; // a negated [Schizo] copy imposes no lock
    const owner = controllerOf(state, self);
    if (owner === null || ctx.player !== owner) return null;
    return "Malware: you cannot activate effects that reveal cards";
  },
  // Freed Jyanshi: this card's CONTROLLER ("you") cannot play cards from hand — no Normal
  // Summon and no activating effects from the hand. (Overlay it onto an opponent to lock them.)
  "MJG-000:bottom": (state, self, ctx) => {
    if (isEffectNegated(state, self)) return null; // a negated [Schizo] copy imposes no lock
    const owner = controllerOf(state, self);
    if (owner === null || ctx.player !== owner) return null;
    if (ctx.kind === "summon" || (ctx.kind === "activate" && ctx.from === "hand")) {
      return "Freed Jyanshi: you cannot play cards from your hand";
    }
    return null;
  },
  // KORO "Iishanten Hell": opponents (of KORO's controller) cannot make melds.
  "MJG-C03:top": (state, self, ctx) => {
    if (ctx.kind !== "meld") return null;
    const owner = controllerOf(state, self);
    if (owner === null || ctx.player === owner) return null;
    return "Iishanten Hell: opponents cannot make melds";
  },
  // YUME "Housepet (formerly)": players cannot activate SPELL effects unless they
  // control a [Schizo].
  "MJG-C09:top": (state, _self, ctx) => {
    if (ctx.kind !== "activate" || ctx.abilityType !== "S") return null;
    return controlsSchizo(state, ctx.player) ? null : "Housepet: cannot activate SPELL effects without a [Schizo]";
  },
  // KIRA "President": players cannot activate ACTIVE effects unless they control
  // a [Schizo].
  "MJG-C11:top": (state, _self, ctx) => {
    if (ctx.kind !== "activate" || ctx.abilityType !== "A") return null;
    return controlsSchizo(state, ctx.player) ? null : "President: cannot activate ACTIVE effects without a [Schizo]";
  },
  // MARY "Literary Club": a player must discard 1 card to attack unless they control a
  // [Schizo]. Here it only BLOCKS the attack when the cost can't be paid (empty hand,
  // no [Schizo]); the discard cost itself is paid at declaration (session).
  "MJG-C10:top": (state, _self, ctx) => {
    if (ctx.kind !== "attack" || controlsSchizo(state, ctx.player)) return null;
    const p = state.players.find((x) => x.pid === ctx.player);
    // a Brick ([B]) can't be discarded, so it doesn't count toward the attack's discard cost
    return p && p.hand.some((iid) => !isBrick(state.instances[iid]?.cardId)) ? null : "Literary Club: must discard a card to attack (no discardable card in hand)";
  },
};

/** First forbidden-reason from any active restriction aura, or null if allowed. */
export function checkRestrictions(state: GameState, ctx: RestrictionContext): string | null {
  // Shoumakyou (MJG-C04): a turn-scoped, state-level lock — the locker's OPPONENTS
  // cannot activate effects for the rest of this turn. (Not a board aura.)
  if (ctx.kind === "activate" && state.effectLockBy !== null && ctx.player !== state.effectLockBy) {
    return "Shoumakyou: opponents cannot activate effects this turn";
  }
  for (const p of state.players) {
    if (p.eliminated) continue;
    for (const iid of p.board) {
      if (!isLive(state, iid)) continue;
      // a card's own cardId, plus any it gains via Twin Personality (overlaid cards' restriction
      // auras apply AS this card — self stays `iid`).
      for (const cardId of abilityCardIds(state, iid)) {
        for (const role of ROLES) {
          const r = RESTRICTIONS[`${cardId}:${role}`];
          if (r) {
            const reason = r(state, iid, ctx);
            if (reason) return reason;
          }
        }
      }
    }
  }
  return null;
}
