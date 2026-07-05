/**
 * MJGTCG continuous (passive) auras.
 *
 * Auras are computed, not stored: `statOf` applies a card's base + stored mods,
 * then the live contributions returned by `computeAuras` for the current state.
 * Each aura is keyed `${cardId}:${role}` and returns AuraContributions targeting
 * one or more on-field instances.
 *
 * IMPORTANT: aura functions must read only counts/conditions (tribes, hand size,
 * banish count, board membership) — never effective stats (statOf) — or they
 * recurse, since statOf calls the provider. Face-down sources/cards are treated
 * as not existing and are skipped/uncounted.
 */
import { isEffectNegated, isEffectImmune, tribesOf, abilityCardIds, type GameState, type AuraContribution } from "./reducer.js";
import type { Seat } from "./rules.js";

export type ContinuousAura = (state: GameState, self: string) => AuraContribution[];

const ROLES = ["top", "bottom"] as const;
// face-down or effect-negated (Shadow Clone / Antipsychotics) SOURCES contribute
// nothing — but a negated card still EXISTS for counting purposes (it keeps its
// tribe/identity; only its own effects are off).
const isLive = (state: GameState, iid: string): boolean =>
  !state.instances[iid]?.faceDown && !isEffectNegated(state, iid);
function controllerOf(state: GameState, iid: string): Seat | null {
  return state.players.find((p) => p.board.includes(iid))?.pid ?? null;
}
/** Face-up board cards of living players — the counting pool ("each [Furry] on
 *  any board"). Face-down cards have no visible identity; negated ones count. */
function allBoardIids(state: GameState): string[] {
  return state.players.flatMap((p) => (p.eliminated ? [] : p.board)).filter((i) => !state.instances[i]?.faceDown);
}

/** +1 ATK & DEF per OTHER face-up [Furry] on any board ("Strength in Numbers"). */
const furryLord: ContinuousAura = (state, self) => {
  const n = allBoardIids(state).filter(
    (i) => i !== self && state.instances[i]?.tribes.includes("Furry"),
  ).length;
  return n === 0
    ? []
    : [
        { iid: self, stat: "atk", op: "add", amount: n },
        { iid: self, stat: "def", op: "add", amount: n },
      ];
};

export const CONTINUOUS_AURAS: Record<string, ContinuousAura> = {
  "MJG-0w0:top": furryLord, // Mating!
  "MJG-M07:top": furryLord, // El Primer Furry
  "MJG-M15:top": furryLord, // Sechs with Zechs
  "MJG-M18:top": furryLord, // El Negro Kang

  // Ojisan "Task Force President": your characters gain +1 DEF (including this).
  "MJG-C28:top": (state, self) => {
    const owner = controllerOf(state, self);
    if (owner === null) return [];
    return state.players
      .find((p) => p.pid === owner)!
      .board.filter((i) => isLive(state, i))
      .map((iid) => ({ iid, stat: "def" as const, op: "add" as const, amount: 1 }));
  },

  // Tyrant's Hand: +1 ATK and -1 VALUE (min 1) per banished card (self).
  "MJG-022:top": (state, self) => {
    const n = state.banish.length;
    return n === 0
      ? []
      : [
          { iid: self, stat: "atk", op: "add", amount: n },
          { iid: self, stat: "value", op: "add", amount: -n },
        ];
  },

  // Ravioli Ravioli "Omurice!": +1 ATK, DEF, and VALUE for each overlaid card.
  // (The 8-overlay completed-meld conversion is the checkRavioli invariant.)
  "MJG-039:bottom": (state, self) => {
    const n = state.instances[self]?.overlays.length ?? 0;
    return n === 0
      ? []
      : [
          { iid: self, stat: "atk", op: "add", amount: n },
          { iid: self, stat: "def", op: "add", amount: n },
          { iid: self, stat: "value", op: "add", amount: n },
        ];
  },

  // AI(Steve) "AI Apocalypse": while the battle counterpart's owner has MORE board
  // cards than this card's controller, that character's DEF is 0 — only during a
  // battle with this card (pendingBattle stays set through the outcome reads).
  "MJG-037:top": (state, self) => {
    const b = state.pendingBattle;
    if (!b || !b.attackerId || !b.targetId) return [];
    const other = b.attackerId === self ? b.targetId : b.targetId === self ? b.attackerId : null;
    if (!other) return []; // a battle, but not with this card
    const me = controllerOf(state, self);
    const them = controllerOf(state, other);
    if (me === null || them === null || me === them) return [];
    const mine = state.players.find((p) => p.pid === me)!.board.length;
    const theirs = state.players.find((p) => p.pid === them)!.board.length;
    if (theirs <= mine) return []; // they must have MORE cards on board
    return [{ iid: other, stat: "def", op: "set", amount: 0 }];
  },

  // Take your meds "Antipsychotics": every [Schizo] on a board has its ATK and DEF
  // reduced to 0 (their EFFECT negation lives in isEffectNegated, not here).
  "MJG-035:top": (state) => {
    const out: AuraContribution[] = [];
    for (const p of state.players) {
      if (p.eliminated) continue;
      for (const iid of p.board) {
        const ci = state.instances[iid];
        // [Schizo] includes characters "considered" Schizo by Heaven's Gate (no [Type] tag).
        if (!ci || ci.faceDown || !tribesOf(state, iid).includes("Schizo")) continue;
        out.push({ iid, stat: "atk", op: "set", amount: 0 }, { iid, stat: "def", op: "set", amount: 0 });
      }
    }
    return out;
  },

  // Strawberry Cup "Summon - Berserker": gains the ATK of all overlaid cards (their base ATK —
  // overlays aren't on the field, so no auras apply to them).
  "MJG-C23:top": (state, self) => {
    const ovs = state.instances[self]?.overlays ?? [];
    let sum = 0;
    for (const o of ovs) sum += state.instances[o]?.atk ?? 0;
    return sum === 0 ? [] : [{ iid: self, stat: "atk", op: "add", amount: sum }];
  },

  // Vanilla Cup "Summon - Caster": gains the DEF of all overlaid cards (their base DEF).
  "MJG-C24:top": (state, self) => {
    const ovs = state.instances[self]?.overlays ?? [];
    let sum = 0;
    for (const o of ovs) sum += state.instances[o]?.def ?? 0;
    return sum === 0 ? [] : [{ iid: self, stat: "def", op: "add", amount: sum }];
  },

  // Chocolate Cup "Twin Personality": gains the ATK AND DEF of all overlaid cards (base stats).
  // (It also gains their ABILITIES — see abilityCardIds, applied across every ability lookup.)
  "MJG-C25:top": (state, self) => {
    const ovs = state.instances[self]?.overlays ?? [];
    let atk = 0, def = 0;
    for (const o of ovs) { atk += state.instances[o]?.atk ?? 0; def += state.instances[o]?.def ?? 0; }
    const out: AuraContribution[] = [];
    if (atk !== 0) out.push({ iid: self, stat: "atk", op: "add", amount: atk });
    if (def !== 0) out.push({ iid: self, stat: "def", op: "add", amount: def });
    return out;
  },

  // Mutsugaki "Brat": this character's ATK and DEF are 0 during opponents' turns (i.e. whenever
  // it is not its controller's turn).
  "MSGK-C30:top": (state, self) => {
    const owner = controllerOf(state, self);
    if (owner === null || state.activePlayer === owner) return [];
    return [{ iid: self, stat: "atk", op: "set", amount: 0 }, { iid: self, stat: "def", op: "set", amount: 0 }];
  },

  // Mommy Milkers "Milked": -1 ATK and DEF (min 0) per card in your hand (self).
  "MJG-32歳:top": (state, self) => {
    const owner = controllerOf(state, self);
    if (owner === null) return [];
    const n = state.players.find((p) => p.pid === owner)!.hand.length;
    return n === 0
      ? []
      : [
          { iid: self, stat: "atk", op: "add", amount: -n },
          { iid: self, stat: "def", op: "add", amount: -n },
        ];
  },
};

/** All active aura contributions for the current state (the injected provider). */
export function computeAuras(state: GameState): AuraContribution[] {
  const out: AuraContribution[] = [];
  for (const p of state.players) {
    if (p.eliminated) continue;
    for (const iid of p.board) {
      if (!isLive(state, iid)) continue; // face-down sources do nothing
      // a card's own cardId, plus any it gains via Twin Personality (overlaid cards' auras
      // apply AS this card — self stays `iid`).
      for (const cardId of abilityCardIds(state, iid)) {
        for (const role of ROLES) {
          const aura = CONTINUOUS_AURAS[`${cardId}:${role}`];
          // a Supermodel-immune card ignores FOREIGN auras (its own still apply —
          // a card's own passive isn't another card's effect)
          if (aura) out.push(...aura(state, iid).filter((c) => c.iid === iid || !isEffectImmune(state, c.iid)));
        }
      }
    }
  }
  return out;
}
