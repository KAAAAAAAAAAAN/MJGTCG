/**
 * MJGTCG turn-state reducer — the authoritative state machine.
 *
 * Phase 0 state model: a card *definition* (base_set.json) is immutable; a card
 * *in play* is a mutable CardInstance carrying live stats. Decks are SHARED
 * (Main + Faith) per RULES sec 2 / FAQ R31. State is readonly and updated
 * immutably via the `replace` helper (mirrors Python's dataclasses.replace).
 *
 * The chain/priority/phase/once-per-X machinery is unchanged from the faithful
 * Python port; Phase 0 swaps the per-player opaque-deck model for shared zones
 * and a card-instance registry, and moves tapped/face-down onto instances.
 */
import * as RU from "./rules.js";
import type { Seat, Ability, Trigger, UsageLedger } from "./rules.js";
import { shuffleWith } from "./rng.js";

export const HAND_LIMIT = 10;
export const WIN_MELDS = 4; // default win condition: complete 4 melds (RULES sec 5)

// ---- registries (module-level, like the Python globals) --------------------
let ABILITY_REGISTRY: Record<string, Ability> = {};
export function setRegistry(reg: Record<string, Ability> | null | undefined): void {
  ABILITY_REGISTRY = { ...(reg ?? {}) };
}
export function ability(effectId: string | undefined): Ability | undefined {
  return effectId === undefined ? undefined : ABILITY_REGISTRY[effectId];
}

export interface Card {
  id: string;
  atk?: number;
  def?: number;
  value?: number | null;
  star?: boolean;
  tribes?: string[];
  gender?: string; // "F" | "M" | "N" — hand-curated in base_set.json (cards.py preserves it)
  abilities?: { type?: string; text?: string }[];
  [k: string]: unknown;
}
let CARD_REGISTRY: Record<string, Card> = {};
export function setCardRegistry(cards: Card[] | Record<string, Card> | null | undefined): void {
  if (Array.isArray(cards)) {
    CARD_REGISTRY = {};
    for (const c of cards) if (c && "id" in c) CARD_REGISTRY[c.id] = c;
  } else {
    CARD_REGISTRY = { ...(cards ?? {}) };
  }
}
export function cardData(cardId: string | undefined): Card | undefined {
  return cardId === undefined || cardId === "" ? undefined : CARD_REGISTRY[cardId];
}
/** The printed title of a card's ability (for labelling choices), if known. */
export function abilityTitle(cardId: string | undefined, role: string): string | undefined {
  const abs = cardData(cardId)?.abilities as ({ role?: string; title?: string }[]) | undefined;
  return abs?.find((a) => a.role === role)?.title;
}

// Text fallback only. Deliberately does NOT match "faith deck": many normal
// Main-deck cards merely *reference* the Faith Deck and must stay summonable.
// Faith/Brick are detected structurally below.
const CBNS_PAT =
  /cannot be normal summon|\(cbns\)|must be special summon|must first be special|cannot be normal set/i;
export function canNormalSummon(cardId: string | undefined): boolean {
  const c = cardData(cardId);
  if (!c) return true;
  const abilities = c.abilities ?? [];
  if (abilities.some((a) => a.type === "F" || a.type === "B")) return false;
  const txt = abilities.map((a) => a.text ?? "").join(" ");
  return !CBNS_PAT.test(txt);
}
/** A Brick ([B] ability, e.g. The Brick MJG-C16): cannot be summoned, discarded, or
 *  banished FROM A HAND. If an effect would do any of those, reveal it instead. */
export function isBrick(cardId: string | undefined): boolean {
  return (cardData(cardId)?.abilities ?? []).some((a) => a.type === "B");
}
/** Can this card be SPECIAL summoned? A Brick ([B]) cannot be summoned at all. */
export function canSpecialSummon(cardId: string | undefined): boolean {
  if (!cardData(cardId)) return true; // opaque/unknown -> assume summonable
  return !isBrick(cardId);
}
/** A "non-effect character" (vanilla — no abilities). Opaque/token cards (no card data)
 *  count as non-effect. Used by Vanilla Cup "Holy Grail". */
export function isNonEffect(cardId: string | undefined): boolean {
  const c = cardData(cardId);
  if (!c) return true; // tokens / opaque cards carry no abilities
  return (c.abilities ?? []).length === 0;
}

// ---- enums -----------------------------------------------------------------
export enum Phase {
  TURN_START_DRAW = "TURN_START_DRAW",
  MAIN_PHASE = "MAIN_PHASE",
  ACTION_ANNOUNCED = "ACTION_ANNOUNCED",
  RESPONSE_WINDOW = "RESPONSE_WINDOW",
  PENDING_INPUT = "PENDING_INPUT",
  DISCARD_DOWN = "DISCARD_DOWN",
  FORCED_DISCARD = "FORCED_DISCARD", // an effect forces players to discard board cards one at a time
  TURN_END = "TURN_END",
  ELIMINATED = "ELIMINATED",
  GAME_OVER = "GAME_OVER",
}
export enum ActionType {
  DRAW_RESOLVES = "DRAW_RESOLVES",
  PLAYER_ACTS = "PLAYER_ACTS",
  OPEN_RESPONSE = "OPEN_RESPONSE",
  ADD_TO_CHAIN = "ADD_TO_CHAIN",
  RESOLVE_CHAIN = "RESOLVE_CHAIN", // resolve the WHOLE stack at once (tests / bulk)
  RESOLVE_TOP = "RESOLVE_TOP", // resolve just the top link, then reopen a window
  YIELD_TO_INPUT = "YIELD_TO_INPUT",
  INPUT_COLLECTED = "INPUT_COLLECTED",
  DECLARE_BATTLE = "DECLARE_BATTLE",
  END_TURN = "END_TURN",
  DISCARD = "DISCARD",
  ADVANCE = "ADVANCE",
  RESOLVE_KAN = "RESOLVE_KAN",
  OPEN_TRIGGER_BATCH = "OPEN_TRIGGER_BATCH",
  NORMAL_SUMMON = "NORMAL_SUMMON",
  MELD = "MELD",
  DECLARE_MELD = "DECLARE_MELD", // announce a meld -> declaration response window -> resolve
  PROCESS_EVENTS = "PROCESS_EVENTS",
  DEV_SPAWN = "DEV_SPAWN", // testing only: materialise a card into a player's hand
  OPEN_WINDOW = "OPEN_WINDOW", // open an open-phase priority window (start/end of turn, …)
  CLEAR_EVENTS = "CLEAR_EVENTS", // drain queued trigger events (session collects them first)
}

// ---- card instances ---------------------------------------------------------
export interface StatMod {
  readonly stat: "atk" | "def" | "value";
  readonly op: "add" | "set" | "mul";
  readonly amount: number;
  readonly duration: "endOfTurn" | "persistent";
  readonly source?: string; // iid of the effect source (optional)
}

/** A live contribution from a continuous (passive) aura to one card's stat. */
export interface AuraContribution {
  readonly iid: string;
  readonly stat: "atk" | "def" | "value";
  readonly op: "add" | "set" | "mul";
  readonly amount: number;
}
/** Injected: returns ALL active continuous-aura contributions for the current
 *  state. Kept out of the core reducer to avoid a cycle with the aura registry.
 *  Providers MUST read only counts/conditions, never effective stats (statOf), to
 *  avoid recursion. */
export type AuraProvider = (state: GameState) => AuraContribution[];
let AURA_PROVIDER: AuraProvider | null = null;
export function setAuraProvider(fn: AuraProvider | null): void {
  AURA_PROVIDER = fn;
}

/** Proposed action checked against active restriction/lock auras. */
export interface RestrictionContext {
  kind: "meld" | "activate" | "attack" | "summon";
  player: Seat;
  abilityType?: string; // for "activate": the ability category (S/A/...)
  effectId?: string; // for "activate": the `${cardId}:${role}` being activated
  from?: "hand" | "board" | "discard"; // for "activate": where the ability is activated from
}
/** Injected: returns a forbidden-reason for a proposed action, or null if allowed. */
export type RestrictionChecker = (state: GameState, ctx: RestrictionContext) => string | null;
let RESTRICTION_CHECKER: RestrictionChecker | null = null;
export function setRestrictionChecker(fn: RestrictionChecker | null): void {
  RESTRICTION_CHECKER = fn;
}
function restrict(state: GameState, ctx: RestrictionContext): string | null {
  return RESTRICTION_CHECKER ? RESTRICTION_CHECKER(state, ctx) : null;
}
/** How a would-be battle discard is replaced (null = discard normally): discard a
 *  DIFFERENT card (Miko), or MOVE the loser elsewhere (Yuzu -> deck top). */
export type BattleDiscardReplacement =
  | { kind: "discardInstead"; iid: string }
  | { kind: "moveInstead"; to: "deckTop" | "deckBottom" | "hand" | "banish" }
  | null;
/** Injected: a card about to be discarded BY BATTLE may be replaced. */
export type BattleDiscardReplacer = (state: GameState, iid: string) => BattleDiscardReplacement;
let BATTLE_DISCARD_REPLACER: BattleDiscardReplacer | null = null;
export function setBattleDiscardReplacer(fn: BattleDiscardReplacer | null): void {
  BATTLE_DISCARD_REPLACER = fn;
}
export interface CardInstance {
  readonly iid: string;
  readonly cardId: string; // "" for opaque (test) instances
  readonly atk: number; // base (printed) stats
  readonly def: number;
  readonly value: number | null; // null = ☆ (wild, chosen later)
  readonly tribes: readonly string[];
  readonly faceDown: boolean;
  readonly tapped: boolean;
  readonly counters: Readonly<Record<string, number>>;
  readonly overlays: readonly string[]; // iids beneath this card
  readonly battles: number;
  readonly mods: readonly StatMod[]; // active stat modifiers (over the base)
  // stunned (Ear Rape): cannot attack or use ACTIVE effects (passives stay live)
  readonly stunned?: boolean;
  // was SPECIAL Summoned this turn (Game Limit) — reset at the turn change & on leave-play
  readonly ssThisTurn?: boolean;
  // "negate its effects" (Shadow Clone): no activations, triggers, or auras
  readonly effectsNegated?: boolean;
  // summoned by `source`'s effect: discarded when the source leaves `seat`'s board
  readonly linkedTo?: { readonly source: string; readonly seat: Seat };
  // Immunize: cannot be melded or removed from the owner's board by effects
  // (cleared by the granter's schedule — pendingImmunityEnds — or on leave-play)
  readonly protectedFromEffects?: boolean;
  // minted by an effect (BIG ICHIHIME) — never lived in any deck; badged in the UI
  readonly token?: boolean;
  // free table position (logical units, see BOARD_GEOM) + which of the owner's board
  // pages holds it. Assigned on board entry, owner-draggable, cleared on leave-play.
  // Feeds the positional effects (Noir Attack / Explosive Aria).
  readonly pos?: { readonly x: number; readonly y: number; readonly page: number };
}

/** We're not gay! (Pon Yeehaw, MJG-044): when a live copy ATTACKS a character
 *  with the same parity VALUE, neither is discarded by battle and both owners
 *  draw 1. ☆ (null) VALUEs have no parity, so an unset Pon never matches. */
function wereNotGay(state: GameState, atk: string, def: string): boolean {
  const a = state.instances[atk];
  if (!a || a.cardId !== "MJG-044" || a.faceDown || isEffectNegated(state, atk)) return false;
  const av = valueOf(state, atk);
  const dv = valueOf(state, def);
  return av !== null && dv !== null && av % 2 === dv % 2;
}

/** Draw 1 by a card effect (emits a byEffect draw event for draw triggers). */
function drawOneByEffect(state: GameState, pid: Seat): GameState {
  const card = state.mainDeck[0];
  if (card === undefined) return state;
  state = replace(state, { mainDeck: state.mainDeck.slice(1) });
  const p = player(state, pid);
  state = replacePlayer(state, replace(p, { hand: [...p.hand, card] }));
  return replace(state, { events: [...state.events, { kind: "draw", iid: card, player: pid, byEffect: true }] });
}

/** Animal Tamer (YJK, MJG-043): with a live copy on `pid`'s board, a Normal Meld
 *  using at least one [Furry] material counts as a Special Meld instead. */
export function animalTamer(state: GameState, pid: Seat, mats: readonly string[]): boolean {
  const hasYjk = player(state, pid).board.some((b) => {
    const ci = state.instances[b];
    return ci !== undefined && hasAbility(state, b, "MJG-043") && !ci.faceDown && !isEffectNegated(state, b);
  });
  return hasYjk && mats.some((m) => state.instances[m]?.tribes.includes("Furry"));
}

/** "Cupid Doesn't Exist" (My /mjg/ Crush, MJG-M11): a face-up, non-negated copy
 *  cannot attack and cannot be attacked. */
export function cannotAttack(state: GameState, iid: string): boolean {
  const ci = state.instances[iid];
  return !!ci && hasAbility(state, iid, "MJG-M11") && !ci.faceDown && !isEffectNegated(state, iid);
}
/** A character cannot be ATTACKED if it is MJG-M11 (Cupid Doesn't Exist), or — "PROTECT
 *  Newbaggies" (MJG-M08 "Friendly Uncle") — if its controller has a DIFFERENT face-up,
 *  non-negated Friendly Uncle ("opponents cannot attack your OTHER characters"). */
export function cannotBeAttacked(state: GameState, iid: string): boolean {
  if (cannotAttack(state, iid)) return true;
  const owner = state.players.find((p) => p.board.includes(iid));
  if (!owner) return false;
  return owner.board.some((b) => {
    if (b === iid) return false; // "OTHER" characters — a lone Friendly Uncle is attackable
    const c = state.instances[b];
    return c !== undefined && hasAbility(state, b, "MJG-M08") && !c.faceDown && !isEffectNegated(state, b);
  });
}

/** Matchmaker (MJG-M11): are these two bonded right now (can't attack each other)? */
export function matchmakerBonded(state: GameState, x: string, y: string): boolean {
  return state.matchmakerBonds.some((m) => (m.a === x && m.b === y) || (m.a === y && m.b === x));
}

/** Supermodel (MJG-041): while it is the ONLY card on its controller's board
 *  (face-up, its own passive not negated), it cannot be discarded by battle and
 *  is immune to ALL card effects — removal, stat changes, flips, foreign auras,
 *  even beneficial ones. Targeting stays legal (R16); the effect just fizzles. */
export function isEffectImmune(state: GameState, iid: string): boolean {
  const ci = state.instances[iid];
  if (!ci || !hasAbility(state, iid, "MJG-041") || ci.faceDown) return false;
  const owner = state.players.find((p) => p.board.includes(iid));
  if (!owner || owner.board.length !== 1) return false;
  return !isEffectNegated(state, iid);
}

/** Record that `pid` activated an effect this turn (Shoumakyou's activation gate). */
function noteEffectAct(state: GameState, pid: Seat): GameState {
  return state.effectActsThisTurn.includes(pid) ? state : replace(state, { effectActsThisTurn: [...state.effectActsThisTurn, pid] });
}

/** "SOA" (SOA-C02): does `pid` control a face-up, non-negated Temeraire? Such a player
 *  — and all their cards — are immune to OPPONENT card effects (see `immuneFrom` and the
 *  targeting layer). Mass non-targeted effects are a documented gap. */
export function soaImmune(state: GameState, pid: Seat): boolean {
  const p = state.players.find((x) => x.pid === pid);
  return !!p?.board.some((iid) => {
    const ci = state.instances[iid];
    return !!ci && hasAbility(state, iid, "SOA-C02") && !ci.faceDown && !isEffectNegated(state, iid);
  });
}

/** "Rinshan Kaihou" (MJG-C01): does `pid` control a face-up, non-negated Cute Boy?
 *  Such a player may KAN from hand/discard-top and Faith-searches instead of drawing. */
export function controlsRinshan(state: GameState, pid: Seat): boolean {
  const p = state.players.find((x) => x.pid === pid);
  return !!p?.board.some((iid) => {
    const ci = state.instances[iid];
    return !!ci && hasAbility(state, iid, "MJG-C01") && !ci.faceDown && !isEffectNegated(state, iid);
  });
}

/** "Malware" (HTTP-404): a face-up, non-negated board copy cannot be used as a meld
 *  material (KAN included). A hand/discard copy is unaffected ("while on board"). */
export function cannotBeMelded(state: GameState, iid: string): boolean {
  const ci = state.instances[iid];
  if (!ci || ci.cardId !== "HTTP-404" || ci.faceDown) return false;
  if (!state.players.some((p) => p.board.includes(iid))) return false;
  return !isEffectNegated(state, iid);
}

// "Ya Boy" >reading (MJG-M20): negates the effects of all cards with MORE lines of
// effect text than Ya Boy (4). This is the authoritative set of cards with ≤4 lines
// (whitelist, from the card's ruling) — everything else with effect text is negated
// while a Ya Boy is out. Ya Boy itself (exactly 4) is whitelisted, so it never negates
// itself. Vanilla cards have 0 lines and are implicitly ≤4.
const LINES_LE_4 = new Set<string>([
  "MJG-000", "MJG-001", "MJG-002", "MJG-003", "MJG-008", "MJG-013", "MJG-022", "MJG-029",
  "MJG-043", "MJG-047", "MJG-0w0", "MJG-77*", "MJG-888", "MJG-C05", "MJG-C08", "MJG-C13",
  "MJG-C14", "MJG-C28", "MJG-M07", "MJG-M08", "MJG-M09", "MJG-M11", "MJG-M15", "MJG-M16",
  "MJG-M18", "MJG-M20", "MJG-M21", "MJG-WAN", "MOON-001", "MSGK-C30", "MTG-001", "NYA-001",
  "SHA-001", "SOA-C02", "UGR-005",
]);
/** Does `cardId` have MORE than 4 lines of effect text? (an effect card not whitelisted). */
function overFourLines(cardId: string | undefined): boolean {
  if (!cardId || LINES_LE_4.has(cardId)) return false;
  const c = cardData(cardId);
  return !!c && (c.abilities ?? []).some((a) => ((a as { text?: string }).text ?? "").trim().length > 0);
}
/** "Ya Boy" >reading: is `cardId`'s effect negated by a live Ya Boy on any board?
 *  Purely static (never calls isEffectNegated) so it can't recurse. */
function reReadingNegates(state: GameState, cardId: string | undefined): boolean {
  if (!overFourLines(cardId)) return false;
  return state.players.some(
    (p) => !p.eliminated && p.board.some((b) => {
      const yb = state.instances[b];
      return yb !== undefined && yb.cardId === "MJG-M20" && !yb.faceDown && !yb.effectsNegated;
    }),
  );
}

/** Are this card's EFFECTS negated right now? Static (Shadow Clone's flag), or continuous:
 *  "Ya Boy" >reading (MJG-M20) negates every card with >4 lines of effect text from
 *  anywhere; "Antipsychotics" (MJG-035) negates every [Schizo] from anywhere — each while
 *  a face-up, non-negated copy sits on a living player's board (a >reading-negated
 *  Antipsychotics stops negating [Schizo]). */
export function isEffectNegated(state: GameState, iid: string): boolean {
  const ci = state.instances[iid];
  if (!ci) return false;
  if (ci.effectsNegated) return true;
  if (reReadingNegates(state, ci.cardId)) return true; // Ya Boy: >4 lines
  if (!ci.tribes.includes("Schizo")) return false;
  return state.players.some(
    (p) =>
      !p.eliminated &&
      p.board.some((b) => {
        const nurse = state.instances[b];
        return nurse !== undefined && hasAbility(state, b, "MJG-035") && !nurse.faceDown && !nurse.effectsNegated
          && !reReadingNegates(state, nurse.cardId); // Ya Boy negates Antipsychotics too
      }),
  );
}

/**
 * Effective value of a stat = base, with mods applied in order, then floored.
 * ATK/DEF floor at 0 (FAQ R81); VALUE floors at 1 (R80) unless it is ☆ (null)
 * and unmodified. Returns null only for an unmodified ☆ VALUE.
 */
export function statOf(state: GameState, iid: string, stat: "atk" | "def" | "value"): number | null {
  const ci = inst(state, iid);
  let v: number | null = ci[stat];
  for (const m of ci.mods) {
    if (m.stat !== stat) continue;
    if (m.op === "set") v = m.amount;
    else if (m.op === "add") v = (v ?? 0) + m.amount;
    else if (m.op === "mul") v = (v ?? 0) * m.amount;
  }
  // continuous (passive) auras, recomputed live from board state
  if (AURA_PROVIDER !== null) {
    for (const c of AURA_PROVIDER(state)) {
      if (c.iid !== iid || c.stat !== stat) continue;
      if (c.op === "set") v = c.amount;
      else if (c.op === "add") v = (v ?? 0) + c.amount;
      else if (c.op === "mul") v = (v ?? 0) * c.amount;
    }
  }
  if (v === null) return null;
  return stat === "value" ? Math.max(1, v) : Math.max(0, v);
}
export const atkOf = (s: GameState, iid: string): number => statOf(s, iid, "atk") ?? 0;
export const defOf = (s: GameState, iid: string): number => statOf(s, iid, "def") ?? 0;
export const valueOf = (s: GameState, iid: string): number | null => statOf(s, iid, "value");
/** A `stat` used by a Faith-summon cost: a board card uses its CURRENT (effective) stat,
 *  a hand card uses its printed stat (no board mods/auras apply off-board). */
export function faithCostStat(s: GameState, iid: string, stat: "atk" | "def" | "value"): number {
  const onBoard = s.players.some((p) => p.board.includes(iid));
  return onBoard ? statOf(s, iid, stat) ?? 0 : s.instances[iid]?.[stat] ?? 0;
}
/** Subset-sum: can some subset of `values` sum EXACTLY to `target`? (small inputs) */
export function canSumTo(values: readonly number[], target: number): boolean {
  if (target === 0) return true;
  if (target < 0 || values.length === 0) return false;
  return canSumTo(values.slice(1), target - values[0]!) || canSumTo(values.slice(1), target);
}
/** Subset-sum over up to TWO dimensions at once (Knot: ATK and DEF totals). An `undefined`
 *  target dimension is unconstrained. True iff some subset of `items` hits every constrained
 *  total exactly. */
export function canSumToDims(items: readonly { atk: number; def: number }[], ta: number | undefined, td: number | undefined): boolean {
  const aDone = ta === undefined || ta === 0;
  const dDone = td === undefined || td === 0;
  if (aDone && dDone) return true;
  if ((ta !== undefined && ta < 0) || (td !== undefined && td < 0) || items.length === 0) return false;
  const h = items[0]!, rest = items.slice(1);
  return canSumToDims(rest, ta === undefined ? undefined : ta - h.atk, td === undefined ? undefined : td - h.def) || canSumToDims(rest, ta, td);
}
export interface Meld {
  readonly cards: readonly string[]; // iids (3, or 4 if KAN'd)
  // "single" = a special one-card completed meld (Ravioli's Omurice!) — neither a
  // triplet nor a sequence, so triplet-gated things (KAN, Ninjutsu) don't apply.
  readonly kind: "sequence" | "triplet" | "single";
  readonly kan: boolean;
  // Resolved VALUE of each card, aligned with `cards`. Set when the meld involved
  // ☆ (wild) materials whose value the player pinned at declaration — so a star is
  // a definite value in this meld (e.g. 2,4,☆ -> ☆ is 3). Absent for plain melds.
  readonly values?: readonly number[];
}

// ---- state ------------------------------------------------------------------
export interface ChainLink {
  readonly sourcePlayer: Seat;
  readonly effectId: string | undefined;
  // optional reference to the effect script this link runs on resolution
  readonly script?: { cardId: string; role: string; self: string; controller: Seat; targets?: string[]; opt?: boolean; bellyCopy?: boolean; drewBy?: Seat };
  // strict-PSCT step-wise resolution: index of the NEXT step to resolve (default 0).
  // While < the ability's step count the link stays on the chain between steps so a
  // response window can open before a respondable step. `scratch` carries values
  // across steps (e.g. a summoned count → a later draw).
  readonly step?: number;
  readonly scratch?: Readonly<Record<string, number>>;
  // negated by another effect (e.g. Justice for Lalatano): the link stays on the
  // chain but its script is skipped when it would resolve.
  readonly negated?: boolean;
}

/**
 * Resolves a chain link's effect, returning the new state, or null if the link
 * has no runnable script (e.g. abstract test links / pure trigger markers).
 * Injected (see setEffectResolver) so the core reducer stays decoupled from the
 * card-script registry — avoids a reducer<->effects import cycle.
 */
export type EffectResolver = (
  state: GameState,
  link: ChainLink,
) => { state: GameState; done: boolean; scratch: Record<string, number> } | null;
let EFFECT_RESOLVER: EffectResolver | null = null;
export function setEffectResolver(r: EffectResolver | null): void {
  EFFECT_RESOLVER = r;
}
export interface Battle {
  readonly attackerId: string | undefined;
  readonly targetId: string | undefined;
  readonly declared: boolean;
  // one-sided (fOUnD mEeEeee): the defender "does not fight back" — it can be
  // discarded but can never discard the attacker.
  readonly oneSided?: boolean;
}
/** A game event emitted during reduction; its triggers are collected at the next
 *  open game state (PROCESS_EVENTS). Extended with more kinds in later slices. */
export type TriggerEvent =
  // special marks a SPECIAL Summon (effect intents); the Normal Summon omits it
  | { kind: "summon"; iid: string; player: Seat; special?: boolean; fromDiscard?: boolean } // fromDiscard: SS'd out of the discard pile (Rebirth)
  | { kind: "battleDiscard"; discarder: string; discarded: string; player: Seat }
  // a card was drawn (into a hand); byEffect = drawn by a CARD EFFECT (the draw
  // intent) rather than a game action (turn draw / starting hand / KAN); opening =
  // a starting-hand deal (opponent-draw hand-traps like fOUnD mEeEeee don't fire on it)
  | { kind: "draw"; iid: string; player: Seat; byEffect?: boolean; opening?: boolean }
  | { kind: "toHand"; iid: string; player: Seat } // added (not drawn) from the Main deck to a hand by an effect
  | { kind: "meld"; iid: string; player: Seat } // a card became a meld material
  // two characters fought a battle that resolved (both were on the board); emitted
  // AFTER any battle discards finalize, so "after this card battles" triggers see the
  // settled board. atk/def are the participants (in attacker/defender order).
  | { kind: "battle"; atk: string; def: string }
  // a card went to the discard pile from a player's hand or board (any cause:
  // battle, effect, cost, hand-size, forced); player = who held it ("you discard")
  | { kind: "discarded"; iid: string; player: Seat };

/** Injected collector: events -> triggers (with script refs). Kept out of the
 *  core reducer to avoid a reducer<->card-scripts import cycle. */
export type TriggerCollector = (state: GameState, events: readonly TriggerEvent[]) => Trigger[];
let TRIGGER_COLLECTOR: TriggerCollector | null = null;
export function setTriggerCollector(fn: TriggerCollector | null): void {
  TRIGGER_COLLECTOR = fn;
}
export interface PlayerState {
  readonly pid: Seat;
  readonly hand: readonly string[]; // iids
  readonly board: readonly string[]; // iids (face-up & face-down; flag on instance)
  readonly meldZone: readonly Meld[];
  readonly eliminated: boolean;
  readonly summonedThisTurn: boolean;
  readonly meldedThisTurn: boolean;
  readonly actedThisTurn: boolean; // taken any main-phase action this turn (summon/meld/attack/activate)?
  // player-level counters by name (e.g. "Clown" from The Jongker) — purely tracked
  // for now; no card consumes them yet.
  readonly counters: Record<string, number>;
  // board pages this player has (manually added via the "+" pager button);
  // auto-placement never creates pages — it wraps below on the same page.
  readonly boardPages: number;
}
export interface GameState {
  readonly phase: Phase;
  readonly activePlayer: Seat;
  readonly players: readonly PlayerState[];
  readonly chain: readonly ChainLink[];
  readonly pendingBattle: Battle | null;
  // Battle losers awaiting their discard. While non-empty the machine is in a
  // RESPONSE_WINDOW where "would be discarded by battle … instead" hand-traps
  // (e.g. Miko) may respond; on close the remaining entries are discarded.
  // `by` = the winning card that discards it (for the battleDiscard trigger).
  readonly pendingDiscards: readonly { iid: string; by: string }[];
  // A meld announced and awaiting its declaration response window; resolved (or
  // fizzled) when the window closes. Its materials are public while declared.
  readonly pendingMeld: {
    player: Seat;
    materials: readonly string[];
    values?: readonly number[];
    special: boolean;
    fromHand: boolean;
    tapSource?: string;
    effectId?: string;
    noFaith?: boolean;
  } | null;
  // Forced discards an effect imposes (a board wipe): each group's OWNER discards
  // its cards one at a time (their chosen order), each respondable; groups are
  // processed front-to-back (turn player first, then anticlockwise). FAQ §9.
  readonly pendingForcedDiscards: readonly { player: Seat; iids: readonly string[] }[];
  // "LIVE!" (MJG-C21) with SEVERAL candidate hosts: Spinzaku waits here (off-board)
  // until its OWNER picks the character to overlay on top of (session-prompted).
  // A single candidate is covered immediately; none -> Faith-deck shuffle.
  readonly pendingLivePlacements: readonly { iid: string; controller: Seat }[];
  // cards flipped face-down on a per-effect schedule (see flipDown). `until` says
  // when they flip back: "startOfNextTurn" (Book of Moon) — at the START of
  // `player`'s next turn (ADVANCE); "endOfThisTurn" (Trap Trick) — at the END of
  // `player`'s current turn (enterDiscardOrEnd).
  readonly pendingUnflips: readonly { iid: string; player: Seat; until: "startOfNextTurn" | "endOfThisTurn" }[];
  // "skip your next turn" debts (Copestream): ADVANCE consumes one entry per
  // skipped seat — that seat's turn simply never starts.
  readonly pendingSkips: readonly Seat[];
  // "Right-to-Left" (MJG-028): the Main deck is physically upside-down. Toggling
  // reverses the array, so all top/bottom accessors keep reading the physical pile.
  readonly deckFlipped: boolean;
  // "Book of Eclipse" (MJG-C15 bottom): true while a face-up, non-negated KAGY is on a
  // board — face-down cards do not flip back up. When it falls (KAGY leaves play or is
  // negated), all face-down characters immediately flip face-up. A derived latch.
  readonly eclipseActive: boolean;
  // "Heaven's Gate" (MJG-C22, Sakurai bottom): true while a Sakurai is present on a board.
  // A derived latch — when it falls (the last Sakurai leaves play), all current [Schizo]
  // characters (printed OR "considered" via the no-[Type]-tag aura) are discarded.
  readonly heavensGateLatch: boolean;
  // Immunize protections that lapse "at the start of `player`'s next turn"
  readonly pendingImmunityEnds: readonly { iid: string; player: Seat }[];
  // stuns that lapse when `player` ends a turn (Ear Rape). `skip` defers the FIRST such
  // end-of-turn (set when the stun was applied during `player`'s own turn) so it instead
  // lapses at the end of `player`'s NEXT turn (MJG-C28 "until the owner's next turn").
  readonly pendingUnstuns: readonly { iid: string; player: Seat; skip?: boolean }[];
  // overlaid hand cards returned to `player`'s hand at the end of their turn
  // (Lead Character); no-ops if the host (and thus the overlay) left play.
  // Lead Character: `card` returns to `player`'s hand at their turn end. Plain entries
  // have `card` tucked BENEATH `host`; `cover` entries have `card` ON TOP (covering the
  // host), which pops back onto the board when the cover returns.
  readonly pendingOverlayReturns: readonly { host: string; card: string; player: Seat; cover?: boolean }[];
  // cards to discard at the end of `player`'s turn (Sacred Enjou's borrowed character);
  // no-op if the card already left play.
  readonly pendingEndTurnDiscards: readonly { iid: string; player: Seat }[];
  // "Ashes" (MJG-042): while set, EVERY player may Normal Summon any number of times. Ends
  // at the END of `player`'s NEXT turn — `skip` defers the first such end-of-turn (it was
  // set during `player`'s own turn).
  readonly unlimitedSummon: { player: Seat; skip: boolean } | null;
  // cards to Special Summon from the discard pile at the START of `player`'s next turn
  // ("Ashes"); skipped if the card already left the discard pile.
  readonly pendingStartTurnSummons: readonly { iid: string; player: Seat }[];
  // "Snake Bite" (MJG-048): players who will be poisoned on their NEXT turn (armed now);
  // moved to `poisonActive` when that turn starts.
  readonly pendingPoison: readonly Seat[];
  // players whose CURRENT turn is poisoned: each card they play (summon/meld) discards
  // 1 random card per "poison" counter. Cleared (with their counters) at that turn's end.
  readonly poisonActive: readonly Seat[];
  // "Geass" (MJG-ZERO): a player's NEXT turn will be controlled by `by` (scheduled now,
  // armed at the start of that turn). `geassTargets` records every player already targeted
  // by Geass this game ("only once per game on the same player").
  readonly pendingTurnControl: readonly { player: Seat; by: Seat }[];
  readonly geassTargets: readonly Seat[];
  // while set, the CURRENT turn (belonging to `activePlayer`) is being played by this other
  // seat instead — the controller acts using the active player's hand and board (session-
  // enforced). Recomputed each turn start; null on a normal turn.
  readonly turnControlledBy: Seat | null;
  // a NORMAL SUMMON that was just announced (its response window still open): what
  // Solem (MJG-C34) chains to when the summon put no trigger on the chain. Cleared
  // when the window closes.
  readonly announcedSummon: { iid: string; player: Seat } | null;
  // "Monopoly" (MJG-M05): an effect scheduled "immediately end your turn"; the session ends
  // the named player's turn once the current resolution settles. null = no pending end.
  readonly pendingEndTurn: Seat | null;
  // "Noir Attack" (MJG-C29): the (<=2) characters closest (table geometry) to DealinDemon's just-attacked
  // target, captured at battle resolution; discarded by its on-battle trigger. Reset each battle.
  readonly pendingNoir: readonly string[];
  // mass discards (BAAAANG, Rebirth's wipe, Noir Attack, Explosive Aria...): groups
  // drained ONE CARD AT A TIME by the session with a response window after each.
  // `chooser` (usually the cards' owner) picks the order while several remain;
  // a group without a chooser is pre-ordered and falls in list order.
  readonly pendingEffectDiscards: readonly { readonly chooser?: Seat; readonly iids: readonly string[]; readonly by?: Seat; readonly source?: string }[];
  // "show your hand" reveals (Collusion): `viewer` can see `owner`'s hand.
  // Turn-scoped — cleared at the turn change (ADVANCE).
  readonly handRevealedTo: readonly { owner: Seat; viewer: Seat }[];
  // Matchmaker (MJG-M11) bonds: `a`/`b` can't attack each other and share a discard
  // fate; the bond lapses at the start of `player`'s next turn.
  readonly matchmakerBonds: readonly { a: string; b: string; player: Seat }[];
  // which of their own board pages each player is LOOKING at (client-reported);
  // auto-placement drops new cards onto this page.
  readonly boardView: Readonly<Record<number, number>>;
  // Shoumakyou (MJG-C04): while set, OPPONENTS of `effectLockBy` cannot activate effects
  // for the rest of this turn (cleared at the turn change). `effectActsThisTurn` records
  // who has activated an effect this turn — the activation gate for Shoumakyou.
  readonly effectLockBy: Seat | null;
  readonly effectActsThisTurn: readonly Seat[];
  // Diabolus ex Machina (MJG-C07): players whose hand shuffles into the deck at the end
  // of their turn (scheduled when the effect resolves; processed in enterDiscardOrEnd).
  readonly pendingHandShuffle: readonly Seat[];
  readonly battleDiscardedThisTurn: boolean; // a card was discarded by battle this turn (for "if a card has been discarded by battle this turn")
  readonly resumePhase: Phase | null;
  readonly log: readonly string[];
  readonly seating: readonly Seat[]; // clockwise seating order
  readonly prioritySeat: Seat | null;
  readonly windowActivator: Seat | null;
  // when an open phase-boundary window (start/end of turn, hand-size discard,
  // post-battle, …) empties, the machine returns to this phase. null = a normal
  // action/chain window (closes back to MAIN, settling any pending battle).
  readonly windowReturn: Phase | null;
  readonly usage: UsageLedger;
  readonly winner: Seat | null; // set once the game is decided (phase GAME_OVER)
  // Deterministic PRNG state for in-effect randomness (random discard, hand
  // re-deal, …). Threaded so the game stays replayable; never sent to clients.
  readonly rngState: number;
  // shared zones (instance-id stacks; index 0 = top)
  readonly mainDeck: readonly string[];
  readonly faithDeck: readonly string[];
  readonly discard: readonly string[];
  readonly banish: readonly string[];
  // "Extra Zone" (NYA-999 Catbox): a shared, public off-board zone. An uploaded card's ACTIVE
  // is usable by every player once per turn on their turn (the per-turn limit rides the usage
  // ledger). Cards here are not in play, hand, deck, or discard.
  readonly extraZone: readonly string[];
  // instance registry
  readonly instances: Readonly<Record<string, CardInstance>>;
  // events emitted since the last PROCESS_EVENTS (drained at open game states)
  readonly events: readonly TriggerEvent[];
}
export interface Action {
  type: ActionType;
  player?: Seat;
  effectId?: string;
  attackerId?: string;
  targetId?: string;
  targetRemoved?: boolean;
  attackerRemoved?: boolean;
  discardId?: string;
  triggers?: Trigger[];
  summonId?: string;
  // effect script reference (PLAYER_ACTS announce -> OPEN_RESPONSE / ADD_TO_CHAIN):
  // identifies which card ability resolves this link. controller = action.player.
  // targets are chosen & locked at activation (PSCT) and read by the script.
  script?: { cardId: string; role: string; self: string; targets?: string[]; opt?: boolean };
  // PLAYER_ACTS: tap this instance on activation (using an Active effect taps it)
  tapSource?: string;
  // meld (MELD): the 3 material iids (board and/or top of discard)
  materials?: string[];
  // Resolved VALUE of each material (aligned with `materials`). Pins ☆ (wild)
  // materials to a chosen value when the meld is ambiguous; omitted otherwise.
  values?: number[];
  special?: boolean; // special meld -> not gated by meldedThisTurn
  fromHand?: boolean; // special meld whose materials come from the hand (e.g. >dama)
  noFaith?: boolean; // suppress the default Faith draw on completing a meld
  // KAN (RESOLVE_KAN): which of the player's melds, and the 4th card (from board)
  meldIndex?: number;
  kanMaterial?: string;
  faithSearch?: string; // Rinshan Kaihou (MJG-C01): the Faith card to search out instead of drawing
  // once-per-X ledger key override (PLAYER_ACTS / ADD_TO_CHAIN). OPT is per CARD NAME:
  // a Twin-Personality-granted ability counts as the HOST card's use, so the session
  // sends `${hostCardId}>${effectId}` for granted (`as`) activations.
  usageId?: string;
  // DEV_SPAWN (testing): create cardId as a fresh instance with this iid into a hand
  spawnIid?: string;
  spawnCardId?: string;
  // OPEN_WINDOW: open an open-phase priority window; returnPhase is where to go
  // when it empties (e.g. start/end of turn, hand-size discard).
  returnPhase?: Phase;
}

export class ReducerError extends Error {}

/** Mirror of dataclasses.replace: shallow immutable update. */
export function replace<T>(obj: T, changes: Partial<T>): T {
  return { ...obj, ...changes };
}

// ---- instance helpers -------------------------------------------------------
export function inst(state: GameState, iid: string): CardInstance {
  const i = state.instances[iid];
  if (i === undefined) throw new ReducerError(`no such instance ${iid}`);
  return i;
}
function setInstance(state: GameState, ci: CardInstance): GameState {
  return replace(state, { instances: { ...state.instances, [ci.iid]: ci } });
}
function updateInstance(state: GameState, iid: string, changes: Partial<CardInstance>): GameState {
  return setInstance(state, replace(inst(state, iid), changes));
}

// ---- internal helpers -------------------------------------------------------
export function player(state: GameState, pid: Seat): PlayerState {
  for (const p of state.players) if (p.pid === pid) return p;
  throw new ReducerError(`no such player ${pid}`);
}
function replacePlayer(state: GameState, np: PlayerState): GameState {
  return replace(state, { players: state.players.map((p) => (p.pid === np.pid ? np : p)) });
}
function log(state: GameState, msg: string): GameState {
  return replace(state, { log: [...state.log, msg] });
}
function nextActive(state: GameState): Seat {
  const living = state.players.filter((p) => !p.eliminated).map((p) => p.pid);
  if (living.length === 0) return state.activePlayer;
  if (!living.includes(state.activePlayer)) return living[0]!;
  const seating = state.seating.length ? state.seating : state.players.map((p) => p.pid);
  return RU.nextSeatAnticlockwise(seating, state.activePlayer, living);
}
function seating(state: GameState): Seat[] {
  if (state.seating.length) {
    return [...state.seating].filter((pid) => !player(state, pid).eliminated);
  }
  return state.players.filter((p) => !p.eliminated).map((p) => p.pid);
}
function canChain(effectId: string | undefined): boolean {
  const ab = ability(effectId);
  if (ab === undefined) return false;
  return RU.canActivelyChain(ab);
}

// ---- reduce -----------------------------------------------------------------
export function reduce(state: GameState, action: Action): GameState {
  // orientation runs LAST: a clone/ravioli/matchmaker change (or Book of Eclipse flipping
  // a face-down MJG-028 up) could change whether an MJG-028 is face-up on a board
  return checkDeckOrientation(checkBookOfEclipse(checkRavioli(checkMatchmaker(checkShadowClones(checkHeavensGate(reduceInner(state, action)))))));
}

/** Matchmaker (MJG-M11) shared fate: "if either is discarded, the other is too."
 *  When one bonded card is in the discard pile and its partner is NOT, discard the
 *  partner and drop the bond. Checked after every action; iterates to a fixpoint. */
function checkMatchmaker(state: GameState): GameState {
  for (;;) {
    const inDiscard = (iid: string) => state.discard.includes(iid);
    const bond = state.matchmakerBonds.find(
      (m) => (inDiscard(m.a) && !inDiscard(m.b)) || (inDiscard(m.b) && !inDiscard(m.a)),
    );
    if (!bond) break;
    const victim = inDiscard(bond.a) ? bond.b : bond.a;
    state = replace(state, { matchmakerBonds: state.matchmakerBonds.filter((m) => m !== bond) });
    state = discardInstance(state, victim);
    state = log(state, `Matchmaker: ${state.instances[victim]?.cardId || victim} shares its partner's fate`);
  }
  return state;
}

/** Omurice! (MJG-039): a live copy with 8 overlaid cards discards them and moves
 *  itself to its owner's Meld Zone as a COMPLETED MELD (counts toward the 4-meld
 *  win — the session's winByMelds pass picks it up). Checked after every action. */
function checkRavioli(state: GameState): GameState {
  for (const p of state.players) {
    if (p.eliminated) continue;
    for (const iid of [...p.board]) {
      const ci = state.instances[iid];
      if (!ci || !hasAbility(state, iid, "MJG-039") || ci.faceDown || ci.effectsNegated) continue;
      if (ci.overlays.length < 8) continue;
      const overlays = [...ci.overlays];
      state = updateInstance(state, iid, { overlays: [] }); // detach first (discardInstance would recurse)
      for (const ov of overlays) state = discardInstance(state, ov);
      state = replace(state, {
        players: state.players.map((pl) =>
          pl.pid === p.pid
            ? { ...pl, board: pl.board.filter((x) => x !== iid), meldZone: [...pl.meldZone, { cards: [iid], kind: "single" as const, kan: false }] }
            : pl,
        ),
      });
      state = log(state, `${ci.cardId} ate its fill: 8 overlaid cards discarded — it becomes a completed meld`);
    }
  }
  return state;
}

/** Shadow Clone (MJG-333) linked fate: a card summoned by the effect carries
 *  `linkedTo`; when its summoner is no longer on the recorded seat's board (it
 *  left play, moved boards, or was tucked as an overlay), the clone is discarded.
 *  Checked after every action; the clone's own leave-play clears the marker. */
function checkShadowClones(state: GameState): GameState {
  for (const [iid, ci] of Object.entries(state.instances)) {
    if (!ci.linkedTo) continue;
    if (!state.players.some((p) => p.board.includes(iid))) continue; // not in play
    const src = ci.linkedTo;
    const srcOnBoard = state.players.some((p) => p.pid === src.seat && p.board.includes(src.source));
    if (!srcOnBoard) {
      state = discardInstance(state, iid);
      state = log(state, `${ci.cardId || iid} (shadow clone) is discarded — its summoner left the board`);
    }
  }
  return state;
}

/** "Right-to-Left" (MJG-028): while a face-up copy sits on any living player's
 *  board, play with the deck UPSIDE-DOWN. Implemented physically: when the
 *  condition toggles (the card arrives/leaves/flips), the Main deck array is
 *  reversed — flipping the pile over — so every top/bottom accessor keeps
 *  reading the "physical" top and bottom unchanged. Checked after every action. */
function checkDeckOrientation(state: GameState): GameState {
  const shouldFlip = state.players.some(
    (p) =>
      !p.eliminated &&
      p.board.some((iid) => {
        const ci = state.instances[iid];
        return ci !== undefined && !ci.faceDown && hasAbility(state, iid, "MJG-028");
      }),
  );
  if (shouldFlip === state.deckFlipped) return state;
  state = replace(state, { mainDeck: [...state.mainDeck].reverse(), deckFlipped: shouldFlip });
  return log(state, shouldFlip ? "the deck is flipped upside-down (Right-to-Left)" : "the deck flips back over");
}

/** "Book of Eclipse" (MJG-C15 bottom): a face-up, non-negated KAGY is on a living
 *  player's board — while so, scheduled flip-backs are suppressed (see the unflip
 *  sites). The condition the latch tracks. */
export function bookOfEclipseActive(state: GameState): boolean {
  return state.players.some(
    (p) =>
      !p.eliminated &&
      p.board.some((iid) => {
        const ci = state.instances[iid];
        return ci !== undefined && !ci.faceDown && hasAbility(state, iid, "MJG-C15") && !isEffectNegated(state, iid);
      }),
  );
}

/** Book of Eclipse: when the condition FALLS (KAGY left play or was negated), flip
 *  every face-down character face-up immediately. A derived latch, checked after every
 *  action — mirrors checkDeckOrientation. */
function checkBookOfEclipse(state: GameState): GameState {
  const active = bookOfEclipseActive(state);
  if (active === state.eclipseActive) return state;
  state = replace(state, { eclipseActive: active });
  if (active) return log(state, "Book of Eclipse: face-down cards no longer flip back up");
  // it just ended -> immediately flip all characters face-up
  for (const p of state.players) {
    for (const iid of p.board) {
      const ci = state.instances[iid];
      if (ci?.faceDown) {
        state = updateInstance(state, iid, { faceDown: false });
        state = log(state, `${ci.cardId || iid} flips face-up (Book of Eclipse ends)`);
      }
    }
  }
  return state;
}

/** "Heaven's Gate" (MJG-C22 bottom) aura is live while a face-up, non-negated Sakurai is on
 *  a board. (Sakurai is itself [Schizo], so Antipsychotics negates it — and the aura with it.) */
export function heavensGateActive(state: GameState): boolean {
  return state.players.some(
    (p) =>
      !p.eliminated &&
      p.board.some((iid) => {
        const ci = state.instances[iid];
        return ci !== undefined && hasAbility(state, iid, "MJG-C22") && !ci.faceDown && !isEffectNegated(state, iid);
      }),
  );
}

/** Card IDs whose abilities the board card `iid` currently HAS: its own cardId, plus — for a
 *  live "Twin Personality" (MJG-C25, Chocolate Cup) — every overlaid card's cardId (it gains the
 *  ATK/DEF and ABILITIES of all overlaid cards). Used by every ability lookup (activations,
 *  auras, triggers, restrictions); for every other card it is just `[cardId]`, so their
 *  behaviour is unchanged. */
export function abilityCardIds(state: GameState, iid: string): string[] {
  const ci = state.instances[iid];
  if (!ci || !ci.cardId) return [];
  if (ci.cardId === "MJG-C25" && !ci.faceDown && !isEffectNegated(state, iid) && ci.overlays.length > 0) {
    const out = [ci.cardId];
    for (const o of ci.overlays) {
      const oc = state.instances[o]?.cardId;
      if (oc) out.push(oc);
    }
    return out;
  }
  return [ci.cardId];
}
/** Does `iid` carry `cardId`'s abilities — its own card, or gained via Twin Personality?
 *  THE check for hard-coded board passives (Rinshan, SOA, Gravity, LIVE!, C.C., …), so a
 *  Chocolate Cup host gains them from its overlays like any registry-routed ability. */
export function hasAbility(state: GameState, iid: string, cardId: string): boolean {
  return abilityCardIds(state, iid).includes(cardId);
}

/** Effective [Type] tags of a character: its printed tribes, plus [Schizo] for any character
 *  WITHOUT a [Type] tag while "Heaven's Gate" is active (MJG-C22). All [Schizo]-membership
 *  checks read this so the aura is felt; `isEffectNegated` stays on printed tribes (it defines
 *  the card's identity and would otherwise recurse through here). */
export function tribesOf(state: GameState, iid: string): readonly string[] {
  const ci = state.instances[iid];
  if (!ci) return [];
  if (ci.tribes.length === 0 && heavensGateActive(state)) return ["Schizo"];
  return ci.tribes;
}

/** "Heaven's Gate" leave-play wipe: latch on a Sakurai being PRESENT on a board (face-up or
 *  down, so a flip/negate does NOT trip it). When it falls — the last Sakurai left play —
 *  discard all current [Schizo] characters: printed [Schizo] OR "considered" [Schizo] (no
 *  [Type] tag). Mirrors checkBookOfEclipse; runs innermost so later latches see the result. */
function checkHeavensGate(state: GameState): GameState {
  const present = state.players.some(
    (p) => !p.eliminated && p.board.some((iid) => hasAbility(state, iid, "MJG-C22")),
  );
  if (present === state.heavensGateLatch) return state;
  state = replace(state, { heavensGateLatch: present });
  if (present) return state; // a Sakurai just arrived — nothing to do
  const victims: string[] = [];
  for (const p of state.players) {
    for (const iid of p.board) {
      const ci = state.instances[iid];
      if (!ci || ci.faceDown) continue; // face-down cards have no visible [Type] identity
      if (ci.tribes.includes("Schizo") || ci.tribes.length === 0) victims.push(iid);
    }
  }
  for (const iid of victims) {
    if (state.players.some((p) => p.board.includes(iid))) state = discardInstance(state, iid);
  }
  if (victims.length) state = log(state, `Heaven's Gate falls — all [Schizo] characters are discarded`);
  return state;
}

function reduceInner(state: GameState, action: Action): GameState {
  const p = state.phase;
  const a = action.type;

  // DEV/testing escape hatch: drop a card into a hand regardless of phase.
  if (a === ActionType.DEV_SPAWN) {
    const pid = action.player ?? state.activePlayer;
    const iid = action.spawnIid!;
    if (state.instances[iid]) throw new ReducerError(`instance ${iid} already exists`);
    state = setInstance(state, makeInstance(iid, action.spawnCardId ?? ""));
    const pl = player(state, pid);
    state = replacePlayer(state, replace(pl, { hand: [...pl.hand, iid] }));
    return log(state, `[dev] player ${pid} spawns ${action.spawnCardId} into hand (${iid})`);
  }
  // Open a phase-boundary priority window (start/end of turn, post-battle, …).
  if (a === ActionType.OPEN_WINDOW) return openWindow(state, action.triggers ?? [], action.returnPhase ?? Phase.MAIN_PHASE);
  if (a === ActionType.CLEAR_EVENTS) return replace(state, { events: [] });
  // Place a trigger batch on the stack (session-driven; any phase, incl. right
  // after a summon while still in ACTION_ANNOUNCED).
  if (a === ActionType.OPEN_TRIGGER_BATCH) return openTriggerBatch(state, action);

  if (p === Phase.TURN_START_DRAW) {
    if (a === ActionType.DRAW_RESOLVES) {
      const ap = player(state, state.activePlayer);
      if (state.mainDeck.length <= 0) {
        // elimination -> ghost board: the player's zones become inert/nonexistent
        // (RULES sec 11). We drop their hand/board/meld references entirely.
        state = replacePlayer(
          state,
          replace(ap, { eliminated: true, hand: [], board: [], meldZone: [] }),
        );
        state = log(state, `player ${ap.pid} drew from empty deck -> eliminated (ghost board)`);
        const living = state.players.filter((p) => !p.eliminated).map((p) => p.pid);
        if (living.length === 1) return gameOver(state, living[0]!, "last player standing");
        if (living.length === 0) return gameOver(state, null, "no players remain");
        return replace(state, { phase: Phase.TURN_END });
      }
      const drawn = state.mainDeck[0]!;
      state = replace(state, { mainDeck: state.mainDeck.slice(1) });
      state = replacePlayer(state, replace(player(state, ap.pid), { hand: [...ap.hand, drawn] }));
      state = replace(state, { phase: Phase.MAIN_PHASE, events: [...state.events, { kind: "draw", iid: drawn, player: ap.pid }] });
      return log(
        state,
        `player ${ap.pid} drew ${drawn} (mainDeck=${state.mainDeck.length},hand=${ap.hand.length + 1})`,
      );
    }
    throw new ReducerError(`${a} illegal in TURN_START_DRAW`);
  }

  if (p === Phase.MAIN_PHASE) {
    // mark that the active player has taken a main-phase action (drives "first
    // action this turn" conditions). END_TURN/PROCESS_EVENTS are not "actions".
    if (a === ActionType.PLAYER_ACTS || a === ActionType.NORMAL_SUMMON || a === ActionType.MELD || a === ActionType.DECLARE_MELD || a === ActionType.DECLARE_BATTLE) {
      const acting = player(state, state.activePlayer);
      if (!acting.actedThisTurn) state = replacePlayer(state, replace(acting, { actedThisTurn: true }));
    }
    // "Snake Bite" (MJG-048): while poisoned, playing a card — a Normal Summon here;
    // Special Summons and Spell/Faith activations charge at their own chokepoints
    // (effects.ts SS intents / OPEN_RESPONSE-ADD_TO_CHAIN announces).
    if (a === ActionType.NORMAL_SUMMON && state.poisonActive.includes(state.activePlayer)) {
      state = chargePoison(state, state.activePlayer, new Set(action.summonId ? [action.summonId] : []));
    }
    if (a === ActionType.PLAYER_ACTS) {
      const ab = ability(action.effectId);
      const rstr = restrict(state, { kind: "activate", player: action.player!, abilityType: ab?.type, effectId: action.effectId });
      if (rstr) throw new ReducerError(rstr);
      // OPT is per CARD NAME: a granted ability's ledger key is namespaced under the
      // host card (usageId) so it doesn't share the granting card's budget.
      const uid = action.usageId ?? action.effectId!;
      if (ab !== undefined && !RU.canActivateOnce(ab, uid, action.player!, state.usage)) {
        throw new ReducerError(`effect ${action.effectId} exhausted its ${RU.onceScope(ab)} limit`);
      }
      if (ab !== undefined) {
        state = replace(state, {
          usage: RU.recordUse(ab, uid, action.player!, state.usage),
        });
      }
      // using an ACTIVE (on-board) effect taps the source card
      if (action.tapSource !== undefined && state.instances[action.tapSource]) {
        state = updateInstance(state, action.tapSource, { tapped: true });
      }
      state = noteEffectAct(state, action.player!); // Shoumakyou: record who activated an effect this turn
      state = replace(state, { phase: Phase.ACTION_ANNOUNCED });
      return log(state, `player ${action.player} acts: ${action.effectId}`);
    }
    if (a === ActionType.NORMAL_SUMMON) return normalSummon(state, action);
    if (a === ActionType.MELD) return doMeld(state, action);
    if (a === ActionType.DECLARE_MELD) return declareMeld(state, action);
    if (a === ActionType.DECLARE_BATTLE) return declareBattle(state, action);
    if (a === ActionType.RESOLVE_KAN) return resolveKan(state, action);
    if (a === ActionType.PROCESS_EVENTS) return processEvents(state);
    if (a === ActionType.END_TURN) return enterDiscardOrEnd(state);
    throw new ReducerError(`${a} illegal in MAIN_PHASE`);
  }

  if (p === Phase.ACTION_ANNOUNCED) {
    if (a === ActionType.OPEN_RESPONSE) {
      const link: ChainLink = {
        sourcePlayer: action.player!,
        effectId: action.effectId,
        script: action.script ? { ...action.script, controller: action.player! } : undefined,
      };
      // default next-priority for standalone reduction. The session overrides this
      // via nextResponder, which also lets the actor respond to themselves (Fix A).
      const seats = seating(state);
      const order = RU.seatOrder(seats, state.activePlayer);
      const nxt = order.find((s) => s !== action.player) ?? action.player!;
      state = noteEffectAct(state, action.player!);
      state = replace(state, {
        phase: Phase.RESPONSE_WINDOW,
        chain: [...state.chain, link],
        windowActivator: action.player!,
        prioritySeat: nxt,
      });
      return log(state, `response window open; chain=${state.chain.length}; priority->${nxt}`);
    }
    if (a === ActionType.RESOLVE_CHAIN) return resolveChain(state);
    if (a === ActionType.RESOLVE_TOP) return resolveTop(state);
    throw new ReducerError(`${a} illegal in ACTION_ANNOUNCED`);
  }

  if (p === Phase.RESPONSE_WINDOW) {
    if (a === ActionType.ADD_TO_CHAIN) {
      if (state.prioritySeat !== null && action.player !== state.prioritySeat) {
        throw new ReducerError(
          `player ${action.player} lacks priority (held by ${state.prioritySeat})`,
        );
      }
      if (!canChain(action.effectId)) {
        throw new ReducerError(
          `effect ${action.effectId} is not (At any time); cannot actively chain`,
        );
      }
      const ab = ability(action.effectId);
      const rstr = restrict(state, { kind: "activate", player: action.player!, abilityType: ab?.type, effectId: action.effectId });
      if (rstr) throw new ReducerError(rstr);
      const uid = action.usageId ?? action.effectId!; // OPT per card name (granted -> host key)
      if (ab !== undefined && !RU.canActivateOnce(ab, uid, action.player!, state.usage)) {
        throw new ReducerError(`effect ${action.effectId} exhausted its ${RU.onceScope(ab)} limit`);
      }
      if (ab !== undefined) {
        state = replace(state, {
          usage: RU.recordUse(ab, uid, action.player!, state.usage),
        });
      }
      const link: ChainLink = {
        sourcePlayer: action.player!,
        effectId: action.effectId,
        script: action.script ? { ...action.script, controller: action.player! } : undefined,
      };
      // default next-priority for standalone reduction. The session overrides this
      // via nextResponder, which also lets the actor respond to themselves (Fix A).
      const seats = seating(state);
      const order = RU.seatOrder(seats, state.activePlayer);
      const nxt = order.find((s) => s !== action.player) ?? action.player!;
      state = noteEffectAct(state, action.player!);
      state = replace(state, {
        chain: [...state.chain, link],
        windowActivator: action.player!,
        prioritySeat: nxt,
      });
      return log(
        state,
        `chain += ${action.effectId} (depth ${state.chain.length}); priority->${nxt}`,
      );
    }
    if (a === ActionType.RESOLVE_CHAIN) {
      state = replace(state, { prioritySeat: null, windowActivator: null });
      return resolveChain(state);
    }
    if (a === ActionType.RESOLVE_TOP) return resolveTop(state);
    if (a === ActionType.YIELD_TO_INPUT) {
      state = replace(state, { phase: Phase.PENDING_INPUT, resumePhase: Phase.RESPONSE_WINDOW });
      return log(state, "yielded to PendingInput (forced ordering)");
    }
    throw new ReducerError(`${a} illegal in RESPONSE_WINDOW`);
  }

  if (p === Phase.PENDING_INPUT) {
    if (a === ActionType.ADD_TO_CHAIN || a === ActionType.OPEN_RESPONSE) {
      throw new ReducerError("chaining is forbidden during PendingInput");
    }
    if (a === ActionType.INPUT_COLLECTED) {
      const resume = state.resumePhase ?? Phase.MAIN_PHASE;
      state = replace(state, { phase: resume, resumePhase: null });
      state = log(state, `input collected; resuming ${resume}`);
      if (resume === Phase.RESPONSE_WINDOW && state.chain.length) return resolveChain(state);
      return state;
    }
    throw new ReducerError(`${a} illegal in PENDING_INPUT`);
  }

  if (p === Phase.DISCARD_DOWN) {
    if (a === ActionType.DISCARD) {
      const ap = player(state, state.activePlayer);
      const removed = pickFromHand(ap.hand, action.discardId);
      state = replacePlayer(state, replace(ap, { hand: removeAt(ap.hand, removed) }));
      if (removed >= 0) {
        const iid = ap.hand[removed]!;
        state = discardOrRedirect(state, iid, ap.pid); // Center Stage K may redirect to the deck
      }
      const nh = player(state, state.activePlayer).hand.length;
      state = log(state, `discarded ${action.discardId ?? "(last)"} (hand=${nh})`);
      // each hand-size discard is an OPEN window (FAQ): respond, then re-check the
      // hand size (closeWindow -> enterDiscardOrEnd routes to DISCARD_DOWN or TURN_END)
      return openWindow(state, [], Phase.DISCARD_DOWN);
    }
    throw new ReducerError(`${a} illegal in DISCARD_DOWN`);
  }

  if (p === Phase.FORCED_DISCARD) {
    if (a === ActionType.DISCARD) {
      const q = state.pendingForcedDiscards;
      const g = q[0];
      const iid = action.discardId;
      if (!g || iid === undefined || !g.iids.includes(iid)) {
        throw new ReducerError(`${iid} is not a current forced discard`);
      }
      state = discardInstance(state, iid);
      const ng = g.iids.filter((x) => x !== iid);
      state = replace(state, { pendingForcedDiscards: [{ player: g.player, iids: ng }, ...q.slice(1)] });
      state = log(state, `player ${g.player} discards ${iid} (forced)`);
      // each forced discard is an OPEN window (FAQ §9): respond, then continue.
      return openWindow(state, [], Phase.FORCED_DISCARD);
    }
    throw new ReducerError(`${a} illegal in FORCED_DISCARD`);
  }

  if (p === Phase.TURN_END) {
    if (a === ActionType.ADVANCE) {
      // untap everything on the (current) active player's board
      const ap = player(state, state.activePlayer);
      for (const iid of ap.board) {
        if (inst(state, iid).tapped) state = updateInstance(state, iid, { tapped: false });
      }
      // expire "until end of turn" stat mods + the "Special Summoned this turn" flag
      for (const [iid, ci] of Object.entries(state.instances)) {
        const expiring = ci.mods.some((m) => m.duration === "endOfTurn");
        if (expiring || ci.ssThisTurn) {
          state = updateInstance(state, iid, {
            ...(expiring ? { mods: ci.mods.filter((m) => m.duration !== "endOfTurn") } : {}),
            ...(ci.ssThisTurn ? { ssThisTurn: false } : {}),
          });
        }
      }
      // "skip your next turn": a skipped seat's turn never starts — consume the
      // debt and move straight on to the seat after them.
      let nxt = nextActive(state);
      const skips = [...state.pendingSkips];
      while (skips.includes(nxt)) {
        skips.splice(skips.indexOf(nxt), 1);
        state = log(state, `player ${nxt}'s turn is skipped`);
        state = replace(state, { activePlayer: nxt }); // advance once more, from the skipped seat
        nxt = nextActive(state);
      }
      state = replace(state, {
        activePlayer: nxt,
        phase: Phase.TURN_START_DRAW,
        usage: RU.resetTurnUsage(state.usage),
        battleDiscardedThisTurn: false, // "this turn" trackers reset at the turn change
        effectLockBy: null, // Shoumakyou's lock lasts only "the rest of this turn"
        effectActsThisTurn: [],
        pendingHandShuffle: [], // safety: any unprocessed end-of-turn shuffle lapses
        pendingSkips: skips,
        handRevealedTo: [], // shown hands close at the turn change
      });
      // reset the new active player's once-per-turn gates
      state = replacePlayer(
        state,
        replace(player(state, nxt), { summonedThisTurn: false, meldedThisTurn: false, actedThisTurn: false }),
      );
      state = log(state, `untap & advance -> player ${nxt} TurnStartDraw`);
      // "face-down until the START of your next turn": that turn has now begun, so
      // the scheduled cards flip back face-up as its first act (not as part of the
      // previous turn's end). ("endOfThisTurn" flips are handled in enterDiscardOrEnd.)
      for (const u of state.pendingUnflips) {
        if (u.player !== nxt || u.until !== "startOfNextTurn") continue;
        const ci = state.instances[u.iid];
        // Book of Eclipse (MJG-C15) suppresses scheduled flip-backs; the card stays down
        // (it flips up when KAGY leaves play — see checkBookOfEclipse).
        if (ci?.faceDown && state.players.some((p) => p.board.includes(u.iid)) && !bookOfEclipseActive(state)) {
          state = updateInstance(state, u.iid, { faceDown: false });
          state = log(state, `${ci.cardId || u.iid} flips face-up (start of player ${nxt}'s turn)`);
        }
      }
      // "Ashes" (MJG-042): Special Summon scheduled cards from the discard at the start of
      // their owner's next turn — unless they left the discard, or a Center Stage T blocks SS.
      for (const pss of state.pendingStartTurnSummons) {
        if (pss.player !== nxt || !state.discard.includes(pss.iid)) continue;
        const dtop = state.discard[0];
        if (dtop !== undefined && state.instances[dtop]?.cardId === "MJG-C34") continue; // Center Stage T
        state = replace(state, { discard: state.discard.filter((x) => x !== pss.iid) });
        state = updateInstance(state, pss.iid, { faceDown: false, tapped: false });
        const pl = player(state, nxt);
        state = replacePlayer(state, replace(pl, { board: [...pl.board, pss.iid] }));
        state = assignBoardPos(state, nxt, pss.iid);
        state = replace(state, { events: [...state.events, { kind: "summon", iid: pss.iid, player: nxt, special: true, fromDiscard: true }] });
        state = log(state, `${state.instances[pss.iid]?.cardId || pss.iid} is Special Summoned from the discard (start of player ${nxt}'s turn)`);
      }
      // Immunize protections lapse at the start of the granter's next turn
      for (const im of state.pendingImmunityEnds) {
        if (im.player !== nxt) continue;
        const ci = state.instances[im.iid];
        if (ci?.protectedFromEffects) {
          state = updateInstance(state, im.iid, { protectedFromEffects: false });
          state = log(state, `${ci.cardId || im.iid} is no longer immunized`);
        }
      }
      // Matchmaker bonds lapse at the start of their activator's next turn
      if (state.matchmakerBonds.some((m) => m.player === nxt)) state = log(state, `Matchmaker bond(s) on player ${nxt} expire`);
      // "Code" (MJG-CC, Pizza Hut Passive): at the start of its controller's turn, remove 1
      // Code counter — or, if it has none left, search the Faith Deck for "The Cart Driver"
      // and add it to that player's hand.
      for (const iid of player(state, nxt).board) {
        const ci = state.instances[iid];
        if (!ci || !hasAbility(state, iid, "MJG-CC") || ci.faceDown || ci.effectsNegated) continue;
        if ((ci.counters["code"] ?? 0) > 0) {
          state = updateInstance(state, iid, { counters: { ...ci.counters, code: ci.counters["code"]! - 1 } });
          state = log(state, `${ci.cardId} removes a Code counter (start of player ${nxt}'s turn)`);
        } else {
          const zero = state.faithDeck.find((f) => state.instances[f]?.cardId === "MJG-ZERO");
          if (zero !== undefined) {
            state = replace(state, { faithDeck: state.faithDeck.filter((f) => f !== zero) });
            const pl = player(state, nxt);
            state = replacePlayer(state, replace(pl, { hand: [...pl.hand, zero] }));
            state = log(state, `Code: no counters left — "The Cart Driver" is added from the Faith Deck to player ${nxt}'s hand`);
          }
        }
      }
      // "Geass" (MJG-ZERO): if this player's turn was marked for control, the named seat
      // now plays it out (session-enforced). Recompute each turn so it lasts exactly one turn.
      const ctl = state.pendingTurnControl.find((c) => c.player === nxt);
      if (ctl) state = log(state, `Geass: player ${ctl.by} controls player ${nxt}'s turn`);
      return replace(state, {
        pendingUnflips: state.pendingUnflips.filter((u) => !(u.player === nxt && u.until === "startOfNextTurn")),
        pendingImmunityEnds: state.pendingImmunityEnds.filter((im) => im.player !== nxt),
        matchmakerBonds: state.matchmakerBonds.filter((m) => m.player !== nxt),
        pendingStartTurnSummons: state.pendingStartTurnSummons.filter((pss) => pss.player !== nxt),
        // "Snake Bite": an armed poison takes effect as the poisoned player's turn begins
        pendingPoison: state.pendingPoison.filter((p) => p !== nxt),
        poisonActive: state.pendingPoison.includes(nxt) && !state.poisonActive.includes(nxt) ? [...state.poisonActive, nxt] : state.poisonActive,
        turnControlledBy: ctl ? ctl.by : null,
        pendingTurnControl: state.pendingTurnControl.filter((c) => c.player !== nxt),
      });
    }
    throw new ReducerError(`${a} illegal in TURN_END`);
  }

  if (p === Phase.ELIMINATED) throw new ReducerError("player is eliminated; no actions");
  if (p === Phase.GAME_OVER) throw new ReducerError("game is over; no actions");
  throw new ReducerError(`unhandled phase ${p}`);
}

function gameOver(state: GameState, winner: Seat | null, reason: string): GameState {
  state = replace(state, { phase: Phase.GAME_OVER, winner });
  return log(
    state,
    winner === null ? `game over: ${reason} (no winner)` : `game over: player ${winner} wins (${reason})`,
  );
}

/** End the game if any living player has reached the meld win condition. Doors the
 *  win for melds made OUTSIDE doMeld (e.g. by an effect like "So Unlucky"); the
 *  session runs this after settling. Idempotent once a winner is set. */
/** Apply a special meld from a player's hand (3 chosen cards forming a valid meld):
 *  move them to the meld zone, draw the default Faith card, and emit meld events.
 *  Throws on an invalid pick. Used by Belly Dance copying a >dama-style hand meld;
 *  the win check is left to the caller (winByMelds). */
export function meldHandCards(state: GameState, pid: Seat, materials: readonly string[]): GameState {
  const ap = player(state, pid);
  if (materials.length !== 3 || new Set(materials).size !== 3) throw new ReducerError("a meld needs 3 distinct cards");
  for (const m of materials) if (!ap.hand.includes(m)) throw new ReducerError(`${m} is not in your hand`);
  const kind = meldKind(materials.map((m) => valueOf(state, m)));
  if (kind === null) throw new ReducerError("those cards don't form a valid meld");
  state = replacePlayer(state, replace(ap, {
    hand: ap.hand.filter((x) => !materials.includes(x)),
    meldZone: [...ap.meldZone, { cards: [...materials], kind, kan: false }],
  }));
  state = replace(state, { events: [...state.events, ...materials.map((iid) => ({ kind: "meld" as const, iid, player: pid }))] });
  if (state.faithDeck.length > 0) {
    const f = state.faithDeck[0]!;
    state = replace(state, { faithDeck: state.faithDeck.slice(1) });
    const ap2 = player(state, pid);
    state = replacePlayer(state, replace(ap2, { hand: [...ap2.hand, f] }));
  }
  return log(state, `player ${pid} special-melds from hand [${materials.join(",")}] (${kind})`);
}

/** Effect meld (MJG-M14, MJG-M19, MJG-C03 "Haitei Raoyue"): form a meld for `pid` from
 *  the given materials, which may sit on ANY players' boards, in `pid`'s own hand, or on
 *  top of the discard pile — they all leave play into `pid`'s meld zone. Draws the
 *  default Faith card (unless `noFaith`) and emits meld events. Throws on an
 *  invalid/illegal set; the win check is left to the caller (winByMelds). */
export function meldBoardCards(state: GameState, pid: Seat, materials: readonly string[], noFaith = false): GameState {
  if (materials.length !== 3 || new Set(materials).size !== 3) throw new ReducerError("a meld needs 3 distinct cards");
  for (const m of materials) {
    const onBoard = state.players.some((p) => p.board.includes(m));
    if (!onBoard && !player(state, pid).hand.includes(m) && !state.discard.includes(m)) throw new ReducerError(`${m} is not a meldable card`);
    if (inst(state, m).protectedFromEffects) throw new ReducerError(`${m} cannot be melded (Immunize)`);
    if (cannotBeMelded(state, m)) throw new ReducerError(`${m} cannot be melded (Malware)`);
    if (isEffectImmune(state, m)) throw new ReducerError(`${m} is immune to effects (Supermodel)`);
  }
  const kind = meldKind(materials.map((m) => valueOf(state, m)));
  if (kind === null) throw new ReducerError("those cards don't form a valid meld");
  // every material leaves wherever it is (any board, pid's hand, the discard) -> meld zone
  state = replace(state, {
    players: state.players.map((p) => ({ ...p, board: p.board.filter((x) => !materials.includes(x)), hand: p.pid === pid ? p.hand.filter((x) => !materials.includes(x)) : p.hand })),
    discard: state.discard.filter((x) => !materials.includes(x)),
  });
  const ap = player(state, pid);
  state = replacePlayer(state, replace(ap, { meldZone: [...ap.meldZone, { cards: [...materials], kind, kan: false }] }));
  state = replace(state, { events: [...state.events, ...materials.map((iid) => ({ kind: "meld" as const, iid, player: pid }))] });
  // default Faith draw, unless suppressed (Tile Efficiency: "They do not draw …")
  if (!noFaith && state.faithDeck.length > 0) {
    const f = state.faithDeck[0]!;
    state = replace(state, { faithDeck: state.faithDeck.slice(1) });
    const ap2 = player(state, pid);
    state = replacePlayer(state, replace(ap2, { hand: [...ap2.hand, f] }));
  }
  return log(state, `player ${pid} effect-melds [${materials.join(",")}] (${kind})${noFaith ? " (no Faith draw)" : ""}`);
}

export function winByMelds(state: GameState): GameState {
  if (state.winner !== null) return state;
  const w = state.players.find((p) => !p.eliminated && p.meldZone.length >= WIN_MELDS);
  return w ? gameOver(state, w.pid, `reached ${WIN_MELDS} melds`) : state;
}

// ---- action handlers --------------------------------------------------------
// ---- meld validation --------------------------------------------------------
/**
 * Classify three VALUEs as a triplet or sequence, allowing ☆ wilds (null) to
 * fill any slot. Returns the meld kind, or null if invalid.
 *  - triplet: all concrete values equal (wilds fill).
 *  - sequence: concrete values distinct and within a 3-consecutive window
 *    (wilds fill the gaps).
 */
export function meldKind(values: (number | null)[]): "triplet" | "sequence" | null {
  const concrete = values.filter((v): v is number => v != null);
  if (concrete.every((v) => v === concrete[0])) return "triplet"; // all-equal or all-wild
  const distinct = new Set(concrete);
  if (distinct.size === concrete.length && Math.max(...concrete) - Math.min(...concrete) <= 2) {
    return "sequence";
  }
  return null;
}

/**
 * Every distinct way a set of 3 materials (☆ = null = wild) can be resolved to a
 * valid meld, as sorted value-tuples. e.g. [2,4,null] -> [[2,3,4]] (forced),
 * [2,3,null] -> [[1,2,3],[2,3,4]] (ambiguous), [2,null,null] -> [[1,2,3],[2,2,2],[2,3,4]].
 * When more than one tuple is returned the player must pick which one their stars are.
 */
export function meldAssignments(values: (number | null)[]): number[][] {
  const stars = values.filter((v) => v == null).length;
  const fixed = values.filter((v): v is number => v != null);
  const seen = new Set<string>();
  const out: number[][] = [];
  const assign = (i: number, acc: number[]): void => {
    if (i === stars) {
      const all = [...fixed, ...acc].sort((a, b) => a - b);
      if (meldKind(all) === null) return;
      const key = all.join(",");
      if (seen.has(key)) return;
      seen.add(key);
      out.push(all);
      return;
    }
    for (let v = 1; v <= 9; v++) assign(i + 1, [...acc, v]);
  };
  assign(0, []);
  return out;
}

/**
 * Partial-meld feasibility, used by the UI so only cards that can still complete
 * a valid meld stay selectable — regardless of pick order.
 *
 * A partial set (1–3 values, ☆ = null = wild) is valid iff it can be a subset of
 * SOME valid 3-meld. So picking a 4 first leaves 2–6 selectable; then picking a 6
 * leaves only 5 (4-5-6). ☆ matches any slot and so never adds a constraint — only
 * the concrete values matter (they must all fit one triplet or one 3-window
 * sequence). This is just `meldKind`'s predicate applied to the concrete subset.
 */
function partialMeldFeasible(concretes: number[]): boolean {
  if (concretes.length === 0) return true;
  if (concretes.length > 3) return false;
  if (concretes.every((x) => x === concretes[0])) return true; // fits a triplet
  const distinct = new Set(concretes).size === concretes.length;
  return distinct && Math.max(...concretes) - Math.min(...concretes) <= 2; // fits a 3-window sequence
}
/** Can `candidate` (a value, or null=☆) be added to an in-progress meld selection? */
export function canExtendMeld(selected: (number | null)[], candidate: number | null): boolean {
  if (selected.length >= 3) return false;
  const concretes = [...selected, candidate].filter((v): v is number => v != null);
  return partialMeldFeasible(concretes);
}
/** The defining value of a triplet meld (first concrete; null if all wild). */
export function tripletValue(state: GameState, m: Meld): number | null {
  // a pinned ☆ counts as the value the player chose at declaration
  if (m.values) {
    for (const v of m.values) if (v != null) return v;
  }
  for (const iid of m.cards) {
    const v = valueOf(state, iid);
    if (v != null) return v;
  }
  return null;
}

function doMeld(state: GameState, action: Action): GameState {
  // A meld of 3: sequential or same VALUE; materials from own board (face-up)
  // and/or the top of the discard pile (at most one). Normal meld is once per
  // turn; special melds are unlimited. Completing a meld draws 1 Faith card by
  // default. RULES sec 5; melded cards leave the board into the meld zone.
  const pid = action.player ?? state.activePlayer;
  if (pid !== state.activePlayer) {
    throw new ReducerError(`only the turn player may meld (player ${pid})`);
  }
  const rstr = restrict(state, { kind: "meld", player: pid });
  if (rstr) throw new ReducerError(rstr);
  const special = !!action.special;
  let ap = player(state, pid);
  // Animal Tamer (MJG-043): a Normal Meld using >=1 [Furry] material counts as a
  // SPECIAL meld instead — it neither needs nor consumes the once-per-turn meld.
  const tamed = !special && animalTamer(state, pid, action.materials ?? []);
  if (!special && !tamed && ap.meldedThisTurn) {
    throw new ReducerError(`player ${pid} already made a normal meld this turn`);
  }
  // an active-driven meld (e.g. >dama) obeys its ability's once-per-turn cap,
  // enforced by effect name so multiple copies still only fire it once.
  if (action.tapSource !== undefined && action.effectId) {
    const ab = ability(action.effectId);
    if (ab && !RU.canActivateOnce(ab, action.effectId, pid, state.usage)) {
      throw new ReducerError(`effect ${action.effectId} exhausted its ${RU.onceScope(ab)} limit`);
    }
    if (ab) state = replace(state, { usage: RU.recordUse(ab, action.effectId, pid, state.usage) });
  }
  const mats = action.materials ?? [];
  if (mats.length !== 3) throw new ReducerError("a meld needs exactly 3 cards");
  if (new Set(mats).size !== 3) throw new ReducerError("meld materials must be distinct");
  const fromHand = !!action.fromHand;
  const top = state.discard[0];
  let fromDiscard = 0;
  if (fromHand) {
    for (const m of mats) {
      if (!ap.hand.includes(m)) throw new ReducerError(`meld material ${m} is not in your hand`);
    }
  } else {
    for (const m of mats) {
      if (m === top) {
        fromDiscard += 1;
      } else if (!(ap.board.includes(m) && !inst(state, m).faceDown)) {
        throw new ReducerError(`meld material ${m} is not a valid source (own face-up board or discard top)`);
      } else if (inst(state, m).protectedFromEffects) {
        throw new ReducerError(`${m} cannot be melded (Immunize)`);
      } else if (cannotBeMelded(state, m)) {
        throw new ReducerError(`${m} cannot be melded (Malware)`);
      }
    }
    if (fromDiscard > 1) throw new ReducerError("only the top card of the discard pile may be used");
  }
  // If the player pinned ☆ values, validate they're consistent with the materials
  // (a fixed card keeps its own value; a ☆ may become any 1-9) and use them for the
  // meld kind. Otherwise fall back to the raw material values (☆ stays wild).
  let resolved: number[] | undefined;
  let kind: "sequence" | "triplet" | null;
  if (action.values !== undefined) {
    const vs = action.values;
    if (vs.length !== mats.length) throw new ReducerError("meld values must specify every material");
    mats.forEach((m, i) => {
      const v = vs[i]!;
      if (!Number.isInteger(v) || v < 1 || v > 9) throw new ReducerError(`invalid meld value ${v}`);
      const printed = valueOf(state, m);
      if (printed != null && printed !== v) throw new ReducerError(`material ${m} has VALUE ${printed}, not ${v}`);
    });
    kind = meldKind(vs);
    if (kind === null) throw new ReducerError("chosen meld values do not form a valid sequence or triplet");
    resolved = [...vs];
  } else {
    kind = meldKind(mats.map((m) => valueOf(state, m)));
    if (kind === null) throw new ReducerError("meld values do not form a valid sequence or triplet");
  }

  // move materials: board materials leave the board; a discard-top material
  // leaves the discard pile.
  ap = replace(ap, {
    hand: fromHand ? ap.hand.filter((x) => !mats.includes(x)) : ap.hand,
    board: fromHand ? ap.board : ap.board.filter((x) => !mats.includes(x)),
    meldZone: [...ap.meldZone, { cards: [...mats], kind, kan: false, ...(resolved ? { values: resolved } : {}) }],
    meldedThisTurn: special || tamed ? ap.meldedThisTurn : true,
  });
  if (tamed) state = log(state, `Animal Tamer: the [Furry] meld counts as a Special Meld`);
  state = replacePlayer(state, ap);
  if (!fromHand && fromDiscard === 1) state = replace(state, { discard: state.discard.filter((x) => x !== top) });
  // using an on-board ACTIVE to meld (e.g. >dama) taps the source card
  if (action.tapSource !== undefined && state.instances[action.tapSource]) {
    state = updateInstance(state, action.tapSource, { tapped: true });
  }
  state = log(
    state,
    `player ${pid} ${special ? "special-" : ""}melds [${mats.join(",")}] (${kind})${fromHand ? " from hand" : fromDiscard ? " using discard top" : ""}`,
  );
  // "if this card is melded" triggers fire for each melded material
  state = replace(state, { events: [...state.events, ...mats.map((iid) => ({ kind: "meld" as const, iid, player: pid }))] });

  // default Faith draw (FAQ R32: no draw if the Faith deck is empty)
  if (!action.noFaith && state.faithDeck.length > 0) {
    const f = state.faithDeck[0]!;
    state = replace(state, { faithDeck: state.faithDeck.slice(1) });
    const ap2 = player(state, pid);
    state = replacePlayer(state, replace(ap2, { hand: [...ap2.hand, f] }));
    state = log(state, `player ${pid} draws Faith card ${f}`);
  }
  // default win condition: reaching WIN_MELDS melds ends the game immediately.
  const meldCount = player(state, pid).meldZone.length;
  if (meldCount >= WIN_MELDS) return gameOver(state, pid, `reached ${WIN_MELDS} melds`);
  // a meld is a response window (RULES sec 7): announce -> window.
  state = replace(state, { phase: Phase.ACTION_ANNOUNCED });
  return log(state, `meld complete (${meldCount} total); window opens`);
}

/** Announce a meld: validate it (a dry-run of doMeld throws on anything illegal),
 *  then store it as `pendingMeld` and open a DECLARATION response window. The
 *  materials are revealed to everyone while declared; the meld only resolves once
 *  the window closes (closeWindow -> resolveMeld). */
function declareMeld(state: GameState, action: Action): GameState {
  doMeld(state, action); // validate only — throws if illegal; the result is discarded
  const pid = action.player ?? state.activePlayer;
  state = replace(state, {
    pendingMeld: {
      player: pid,
      materials: [...(action.materials ?? [])],
      ...(action.values !== undefined ? { values: [...action.values] } : {}),
      special: !!action.special,
      fromHand: !!action.fromHand,
      ...(action.tapSource !== undefined ? { tapSource: action.tapSource } : {}),
      ...(action.effectId !== undefined ? { effectId: action.effectId } : {}),
      ...(action.noFaith !== undefined ? { noFaith: action.noFaith } : {}),
    },
    phase: Phase.ACTION_ANNOUNCED,
  });
  return log(state, `player ${pid} declares meld [${(action.materials ?? []).join(",")}]; window opens`);
}

/** Resolve a declared meld once its window closes: re-validate (it may have been
 *  invalidated mid-window, e.g. a material was bounced) and apply it, else fizzle.
 *  Reuses doMeld for the actual application; collapses its post-window to MAIN. */
function resolveMeld(state: GameState): GameState {
  const pm = state.pendingMeld;
  if (pm === null) return state;
  state = replace(state, { pendingMeld: null });
  try {
    const next = doMeld(state, {
      type: ActionType.MELD,
      player: pm.player,
      materials: [...pm.materials],
      ...(pm.values !== undefined ? { values: [...pm.values] } : {}),
      special: pm.special,
      fromHand: pm.fromHand,
      ...(pm.tapSource !== undefined ? { tapSource: pm.tapSource } : {}),
      ...(pm.effectId !== undefined ? { effectId: pm.effectId } : {}),
      ...(pm.noFaith !== undefined ? { noFaith: pm.noFaith } : {}),
    });
    // doMeld opens its own (post-)window; the declaration window already served
    // that role, so collapse back to MAIN unless the meld ended the game.
    return next.phase === Phase.ACTION_ANNOUNCED ? replace(next, { phase: Phase.MAIN_PHASE }) : next;
  } catch (e) {
    return log(replace(state, { phase: Phase.MAIN_PHASE }), `declared meld fizzled: ${(e as Error).message}`);
  }
}

function resolveKan(state: GameState, action: Action): GameState {
  // KAN: add a 4th card to one of your triplet melds, then draw the BOTTOM of
  // the Main deck. Default source is your board with matching VALUE (☆ matches
  // anything). Ruling 3: KAN resolves IMMEDIATELY; declaration is NOT a window.
  const pid = action.player!;
  const ap = player(state, pid);
  const mi = action.meldIndex;
  if (mi === undefined || ap.meldZone[mi] === undefined) {
    throw new ReducerError(`no such meld ${mi} for player ${pid}`);
  }
  const meld = ap.meldZone[mi]!;
  if (meld.kind !== "triplet") throw new ReducerError("can only KAN a triplet meld");
  if (meld.kan) throw new ReducerError("meld is already KAN'd");
  const mat = action.kanMaterial;
  if (mat === undefined || state.instances[mat] === undefined) throw new ReducerError("KAN needs a material");
  // "FU-FU-FUCK SHAMIKO" (MJG-HAT): a non-negated copy is ANY VALUE for a KAN, and may
  // be used FROM ANYWHERE (your hand, your board, or the discard pile).
  const wild = hasAbility(state, mat, "MJG-HAT") && !isEffectNegated(state, mat);
  // "Rinshan Kaihou" (MJG-C01): while you control Cute Boy you may KAN using a card
  // from your hand or the top of the discard pile (in addition to your board).
  const rinshan = controlsRinshan(state, pid);
  const onBoardFaceUp = ap.board.includes(mat) && !inst(state, mat).faceDown;
  const sourceOk =
    onBoardFaceUp ||
    (wild && (ap.board.includes(mat) || ap.hand.includes(mat) || state.discard.includes(mat))) ||
    (rinshan && (ap.hand.includes(mat) || state.discard[0] === mat));
  if (!sourceOk) throw new ReducerError("KAN material must be a face-up board card (Rinshan/SHAMIKO allow hand/discard)");
  if (inst(state, mat).protectedFromEffects) throw new ReducerError(`${mat} cannot be melded (Immunize)`);
  if (cannotBeMelded(state, mat)) throw new ReducerError(`${mat} cannot be melded (Malware)`);
  const tv = tripletValue(state, meld);
  const mv = wild ? null : inst(state, mat).value; // a wild KAN material skips the VALUE match
  if (mv != null && tv != null && mv !== tv) {
    throw new ReducerError(`KAN material VALUE ${mv} must match the triplet (${tv})`);
  }
  const newMeld: Meld = { ...meld, cards: [...meld.cards, mat], kan: true };
  // the material leaves whatever zone holds it (board / hand for HAT-from-anywhere)
  state = replacePlayer(
    state,
    replace(ap, {
      board: ap.board.filter((x) => x !== mat),
      hand: ap.hand.filter((x) => x !== mat),
      meldZone: ap.meldZone.map((m, i) => (i === mi ? newMeld : m)),
    }),
  );
  if (state.discard.includes(mat)) state = replace(state, { discard: state.discard.filter((x) => x !== mat) });
  state = log(state, `KAN by player ${pid} on meld ${mi} (+${mat}) resolves immediately (no response window)`);

  const events: Record<string, boolean> = { kan: true };
  if (rinshan) {
    // "Rinshan Kaihou": instead of drawing the Main deck bottom, search the Faith Deck
    // for any 1 card (action.faithSearch) and add it to your hand — then shuffle it.
    const fs = action.faithSearch;
    if (fs !== undefined && state.faithDeck.includes(fs)) {
      const rest = state.faithDeck.filter((x) => x !== fs);
      const sh = shuffleWith(state.rngState, rest);
      state = replace(state, { faithDeck: sh.value, rngState: sh.state });
      const ap2 = player(state, pid);
      state = replacePlayer(state, replace(ap2, { hand: [...ap2.hand, fs] }));
      state = log(state, `Rinshan Kaihou: player ${pid} searches the Faith Deck and adds ${fs}`);
      events["self_drew"] = true;
    } else if (state.faithDeck.length > 0) {
      const sh = shuffleWith(state.rngState, state.faithDeck); // searched, took nothing -> still shuffle
      state = replace(state, { faithDeck: sh.value, rngState: sh.state });
      state = log(state, `Rinshan Kaihou: Faith search added nothing`);
    }
  } else if (state.mainDeck.length > 0) {
    const drawn = state.mainDeck[state.mainDeck.length - 1]!; // KAN draws the BOTTOM
    state = replace(state, { mainDeck: state.mainDeck.slice(0, -1) });
    const ap2 = player(state, pid);
    state = replacePlayer(state, replace(ap2, { hand: [...ap2.hand, drawn] }));
    events["self_drew"] = true;
  }
  const labels = RU.kanResolutionTriggers(events);
  state = log(state, `KAN open game state; potential triggers: ${labels.length ? labels : "none"}`);
  return replace(state, { phase: Phase.MAIN_PHASE });
}

/** Place a batch of simultaneous triggers onto the chain in SEGOC order. */
function placeTriggers(state: GameState, triggers: readonly Trigger[]): GameState {
  if (!triggers.length) return state;
  const order = RU.orderSimultaneousTriggers([...triggers], seating(state), state.activePlayer);
  let chain = [...state.chain];
  for (const idx of order) {
    const t = triggers[idx]!;
    chain = [...chain, {
      sourcePlayer: t.player,
      effectId: t.id,
      script: t.script ? { ...t.script, controller: t.player } : undefined,
    }];
  }
  return log(replace(state, { chain }), `SEGOC trigger batch placed: ${triggers.length} links`);
}

function openTriggerBatch(state: GameState, action: Action): GameState {
  state = placeTriggers(state, action.triggers ?? []);
  const nxt = seating(state)[0] ?? state.activePlayer;
  // A batch that interrupts the PRE-DRAW phase (a start-of-turn trigger, e.g. the
  // Phoenix's scheduled return -> Rebirth) must come BACK to it when the chain
  // resolves — otherwise the turn draw would be silently skipped.
  const windowReturn = state.phase === Phase.TURN_START_DRAW ? Phase.TURN_START_DRAW : state.windowReturn;
  state = replace(state, { phase: Phase.RESPONSE_WINDOW, windowActivator: state.activePlayer, prioritySeat: nxt, windowReturn });
  return log(state, `trigger batch -> response window; priority->${nxt}`);
}

/**
 * Open an OPEN-PHASE priority window (start/end of turn, hand-size discard,
 * post-battle, …): place any batched triggers (SEGOC), then a response window
 * with priority anticlockwise from the turn player. When it empties, the machine
 * returns to `returnPhase` (see resolveTop).
 */
function openWindow(state: GameState, triggers: readonly Trigger[], returnPhase: Phase): GameState {
  state = placeTriggers(state, triggers);
  state = replace(state, {
    phase: Phase.RESPONSE_WINDOW,
    windowActivator: null, // anchor at the turn player (post-resolution priority)
    prioritySeat: state.activePlayer,
    windowReturn: returnPhase,
  });
  return log(state, `open window -> RESPONSE_WINDOW (return ${returnPhase}); priority->${state.activePlayer}`);
}

function resolveChain(state: GameState): GameState {
  for (let i = state.chain.length - 1; i >= 0; i--) {
    const link = state.chain[i]!;
    if (link.negated) {
      state = log(state, `${link.effectId} was negated — fizzles`);
      continue;
    }
    state = log(state, `resolve ${link.effectId} (player ${link.sourcePlayer})`);
    // Synchronous (no-priority) path: run ALL of the link's steps to completion —
    // there are no inter-step response windows here (that's the RESOLVE_TOP path).
    if (EFFECT_RESOLVER) {
      let cur = link;
      for (;;) {
        const r = EFFECT_RESOLVER(state, cur);
        if (r === null) break;
        state = r.state;
        if (r.done) break;
        cur = { ...cur, step: (cur.step ?? 0) + 1, scratch: r.scratch };
      }
    }
  }
  if (state.pendingBattle !== null) state = resolveBattle(state);
  state = replace(state, { phase: Phase.MAIN_PHASE, chain: [] });
  return log(state, "chain fully resolved -> MainPhase");
}

/**
 * Resolve only the TOP link of the stack (LIFO), then REOPEN a response window so
 * players can respond mid-resolution (PSCT: "keep adding to it at any point").
 * Triggers spawned by the resolution go on top of the stack and get their own
 * window. When the stack empties, a pending battle settles and we return to MAIN.
 */
function resolveTop(state: GameState): GameState {
  // Resolve exactly ONE link, then stay in the window. The SESSION drives the loop:
  // it processes any events this resolution emitted (placing triggers — and
  // prompting for optional ones) BEFORE the next RESOLVE_TOP, and closes the window
  // (here, when empty) only once the stack and events are both drained.
  if (state.chain.length === 0) return closeWindow(state);
  const i = state.chain.length - 1;
  const link = state.chain[i]!;
  if (link.negated) {
    state = log(state, `${link.effectId} was negated — fizzles`);
    return replace(state, {
      chain: state.chain.slice(0, i),
      phase: Phase.RESPONSE_WINDOW,
      windowActivator: null,
      prioritySeat: state.activePlayer,
    });
  }
  state = log(state, `resolve ${link.effectId} (player ${link.sourcePlayer})`);
  let done = true;
  let scratch: Record<string, number> | undefined;
  if (EFFECT_RESOLVER) {
    const r = EFFECT_RESOLVER(state, link);
    if (r !== null) {
      state = r.state;
      done = r.done;
      scratch = r.scratch;
    }
  }
  // Strict PSCT: if the ability has more steps, keep the link on the chain with its
  // cursor advanced (the session opens a response window before a respondable step,
  // or resolves the next step immediately for a simultaneous one). Else pop it.
  const chain = done
    ? state.chain.slice(0, i)
    : [...state.chain.slice(0, i), { ...link, step: (link.step ?? 0) + 1, scratch }];
  return replace(state, {
    chain,
    phase: Phase.RESPONSE_WINDOW,
    windowActivator: null, // post-resolution priority anchors at the turn player
    prioritySeat: state.activePlayer,
  });
}

/** The stack is empty: leave the window. Phase-boundary windows return to their
 *  `windowReturn`; a normal action window settles a pending battle (opening an
 *  open post-battle window whose triggers/events the session then processes) or
 *  returns to MAIN. */
function closeWindow(state: GameState): GameState {
  const ret = state.windowReturn;
  if (ret !== null) {
    // An effect that resolved INSIDE a phase-boundary window may have set up a battle
    // (fOUnD mEeEeee's one-sided attack on an opponent's draw). A battle must settle
    // immediately — do it before honoring the return phase (beginBattleDiscards opens
    // its own windows and ends in the main phase).
    if (state.pendingBattle !== null) return beginBattleDiscards(state);
    state = replace(state, { windowReturn: null, windowActivator: null, prioritySeat: null, announcedSummon: null });
    // DISCARD_DOWN re-checks the hand size; FORCED_DISCARD advances its queue
    if (ret === Phase.DISCARD_DOWN) return enterDiscardOrEnd(state);
    if (ret === Phase.FORCED_DISCARD) return enterForcedDiscard(state);
    return replace(state, { phase: ret });
  }
  // A battle-discard window just closed: discard the losers that weren't saved by
  // an "instead" hand-trap, then open the post-battle window (FAQ).
  if (state.pendingDiscards.length > 0) {
    state = finalizeBattleDiscards(state);
    return openWindow(state, [], Phase.MAIN_PHASE);
  }
  // An effect imposed forced discards (a board wipe): process them one at a time.
  if (state.pendingForcedDiscards.length > 0) {
    return enterForcedDiscard(state);
  }
  // The meld declaration window closed: resolve (or fizzle) the declared meld.
  if (state.pendingMeld !== null) {
    return resolveMeld(state);
  }
  // The battle declaration window closed: compute the battle and open the
  // discard window (where "would be discarded … instead" hand-traps respond).
  if (state.pendingBattle !== null) {
    return beginBattleDiscards(state);
  }
  return replace(state, { phase: Phase.MAIN_PHASE, windowActivator: null, prioritySeat: null, announcedSummon: null });
}

function normalSummon(state: GameState, action: Action): GameState {
  // Normal summon (once per turn, turn player only). Enforces the gate and
  // Faith/CbNS legality (RULES sec 4), moves the chosen hand instance to the
  // board face-up & untapped, then ANNOUNCES the summon (RULES sec 7).
  const pid = action.player ?? state.activePlayer;
  if (pid !== state.activePlayer) {
    throw new ReducerError(`only the turn player may normal summon (player ${pid})`);
  }
  const ap = player(state, pid);
  if (ap.summonedThisTurn && state.unlimitedSummon === null) {
    throw new ReducerError(`player ${pid} already normal summoned this turn`);
  }
  const iid = action.summonId;
  if (iid === undefined || !ap.hand.includes(iid)) {
    throw new ReducerError(`normal summon target ${iid} not in player ${pid} hand`);
  }
  const cardId = inst(state, iid).cardId;
  if (!canNormalSummon(cardId)) {
    throw new ReducerError(`${iid} (${cardId || "opaque"}) cannot be normal summoned (Faith/CbNS)`);
  }
  const summonLock = restrict(state, { kind: "summon", player: pid }); // Freed Jyanshi: no playing from hand
  if (summonLock) throw new ReducerError(summonLock);
  state = updateInstance(state, iid, { faceDown: false, tapped: false });
  state = replacePlayer(
    state,
    replace(ap, {
      hand: ap.hand.filter((x) => x !== iid),
      board: [...ap.board, iid],
      summonedThisTurn: true,
    }),
  );
  state = assignBoardPos(state, pid, iid);
  state = replace(state, {
    phase: Phase.ACTION_ANNOUNCED,
    events: [...state.events, { kind: "summon", iid, player: pid }],
    announcedSummon: { iid, player: pid }, // Solem can chain to this announcement
  });
  return log(state, `player ${pid} normal summons ${iid} (${cardId || "opaque"}) -> board; window opens`);
}

/** Drain queued events: collect their triggers (via the injected collector) and,
 *  if any, batch them onto the stack SEGOC-style; otherwise stay put. Called at
 *  open game states (RULES: triggers join the stack at open windows, not mid-
 *  resolution). */
function processEvents(state: GameState): GameState {
  const evs = state.events;
  state = replace(state, { events: [] });
  if (TRIGGER_COLLECTOR === null || evs.length === 0) {
    return log(state, "process events: nothing to do");
  }
  const trigs = TRIGGER_COLLECTOR(state, evs);
  if (trigs.length === 0) return log(state, `process events: ${evs.length} event(s), no triggers`);
  return openTriggerBatch(state, { type: ActionType.OPEN_TRIGGER_BATCH, triggers: trigs });
}

function declareBattle(state: GameState, action: Action): GameState {
  const atk = action.attackerId, def = action.targetId;
  // attack restrictions (Cupid Doesn't Exist / Matchmaker) — defence in depth
  if (atk !== undefined && cannotAttack(state, atk)) throw new ReducerError(`${atk} cannot attack`);
  if (def !== undefined && cannotBeAttacked(state, def)) throw new ReducerError(`${def} cannot be attacked`);
  if (atk !== undefined && def !== undefined && matchmakerBonded(state, atk, def)) {
    throw new ReducerError(`${atk} and ${def} cannot attack each other (Matchmaker)`);
  }
  // "Gravity of a Boss" (MJG-C29): when DealinDemon attacks, the defender does not fight back.
  const gravity = atk !== undefined && hasAbility(state, atk, "MJG-C29") && !state.instances[atk]?.faceDown && !isEffectNegated(state, atk);
  const b: Battle = { attackerId: action.attackerId, targetId: action.targetId, declared: true, ...(gravity ? { oneSided: true } : {}) };
  if (action.attackerRemoved || action.targetRemoved) {
    state = log(
      state,
      `battle ${action.attackerId} -> ${action.targetId} fizzled at declaration (stays UNTAPPED)`,
    );
    return replace(state, { pendingBattle: null });
  }
  // declaration opens a response window; RESOLVE_CHAIN then computes the battle
  state = replace(state, { pendingBattle: b, phase: Phase.ACTION_ANNOUNCED });
  return log(state, `battle declared: ${action.attackerId} -> ${action.targetId}; window opens`);
}

/** Discard a card from play to the TOP of the discard pile, clearing leave-play
 *  state (mods/counters/battles) and discarding its overlaid cards too. */
/** Send `iid` (already detached from its zone) to the TOP of the discard pile, emitting
 *  its "discarded" event for `holder` — UNLESS a "Center Stage" card is on TOP of the pile:
 *   - Center Stage K (MJG-C31): shuffle it into the Main deck instead (NOT discarded — no event);
 *   - Center Stage M (MJG-C33): still discarded (event fires), but placed on the BOTTOM. */
/**
 * "C.C." (MJG-CC, Pizza Hut top): if this face-up Pizza Hut on a board would be discarded
 * or banished, place a Code counter on it INSTEAD and keep it in play. Returns the new state
 * when the replacement applies (a counter was added, the card stays), or null otherwise.
 * Suppressed while the card's effects are negated.
 */
export function pizzaHutCode(state: GameState, iid: string): GameState | null {
  const ci = state.instances[iid];
  if (!ci || !hasAbility(state, iid, "MJG-CC") || ci.faceDown || ci.effectsNegated) return null;
  if (!state.players.some((p) => p.board.includes(iid))) return null; // only the on-board character
  const s = updateInstance(state, iid, { counters: { ...ci.counters, code: (ci.counters["code"] ?? 0) + 1 } });
  return log(s, `${ci.cardId} gains a Code counter instead of leaving play (C.C.)`);
}

/**
 * "LIVE!" (MJG-C21, Spinzaku bottom, Mandatory): if this face-up Spinzaku on a board would
 * be discarded or banished, it instead overlays ON TOP of another character — Spinzaku takes
 * that character's board slot as the stack top and the character (plus its materials, flat)
 * tucks beneath it. If there is no other character to cover, it is shuffled into the Faith
 * Deck. Returns the new state when the replacement applies, else null (suppressed while its
 * effects are negated). The "another character" choice is auto-resolved: the controller's own
 * other characters are preferred, then any opponent's (the pure reducer cannot prompt here —
 * covering an opponent's character puts Spinzaku on THEIR board: position = control).
 */
export function liveRedirect(state: GameState, iid: string): GameState | null {
  const ci = state.instances[iid];
  if (!ci || !hasAbility(state, iid, "MJG-C21") || ci.faceDown || ci.effectsNegated) return null;
  const controller = state.players.find((p) => p.board.includes(iid))?.pid;
  if (controller === undefined) return null; // only the on-board character
  // every live candidate host, own board first (the auto-pick when only one exists)
  const candidates: string[] = [];
  for (const p of [player(state, controller), ...state.players.filter((p) => p.pid !== controller && !p.eliminated)]) {
    for (const x of p.board) if (x !== iid && !state.instances[x]?.faceDown) candidates.push(x);
  }
  let s = state;
  for (const ov of ci.overlays) s = discardInstance(s, ov); // Spinzaku's own overlays leave play
  s = replace(s, { players: s.players.map((p) => ({ ...p, board: p.board.filter((x) => x !== iid) })) });
  s = updateInstance(s, iid, {
    mods: [], counters: {}, battles: 0, overlays: [], tapped: false, faceDown: false, stunned: false, ssThisTurn: false, effectsNegated: false, linkedTo: undefined, protectedFromEffects: false, pos: undefined,
  });
  if (candidates.length === 1) return liveCover(s, iid, candidates[0]!);
  if (candidates.length > 1) {
    // several possible hosts: the OWNER picks — Spinzaku waits off-board until the
    // session-driven choice places it (see pendingLivePlacements).
    s = replace(s, { pendingLivePlacements: [...s.pendingLivePlacements, { iid, controller }] });
    return log(s, `LIVE!: player ${controller} chooses a character for ${ci.cardId} to overlay on top of`);
  }
  const sh = shuffleWith(s.rngState, [...s.faithDeck, iid]);
  s = replace(s, { rngState: sh.state, faithDeck: sh.value });
  return log(s, `${ci.cardId} is shuffled into the Faith Deck instead of leaving play (LIVE!)`);
}
/** Place a waiting (or single-candidate) LIVE! Spinzaku ON TOP of `host`: it takes the
 *  host's board slot as the stack top; the host (plus its materials, flat) tucks beneath. */
export function liveCover(state: GameState, iid: string, host: string): GameState {
  const hc = state.instances[host]!;
  const hostOwner = state.players.find((p) => p.board.includes(host))!.pid;
  const s = replace(state, {
    players: state.players.map((p) => (p.pid === hostOwner ? { ...p, board: p.board.map((x) => (x === host ? iid : x)) } : p)),
    instances: { ...state.instances,
      [host]: { ...hc, overlays: [] },
      [iid]: { ...state.instances[iid]!, overlays: [host, ...hc.overlays], pos: hc.pos }, // takes the host's table spot
    },
    pendingLivePlacements: state.pendingLivePlacements.filter((pl) => pl.iid !== iid),
  });
  return log(s, `${state.instances[iid]?.cardId} overlays on top of ${hc.cardId || host} instead of leaving play (LIVE!)`);
}

export function discardOrRedirect(state: GameState, iid: string, holder?: Seat): GameState {
  const top = state.discard[0];
  const topId = top !== undefined && top !== iid ? state.instances[top]?.cardId : undefined;
  if (topId === "MJG-C31") {
    const sh = shuffleWith(state.rngState, [...state.mainDeck, iid]);
    return replace(state, {
      rngState: sh.state,
      mainDeck: sh.value,
      log: [...state.log, `${state.instances[iid]?.cardId || iid} is shuffled into the deck instead of discarded (Center Stage K)`],
    });
  }
  const toBottom = topId === "MJG-C33"; // Center Stage M
  return replace(state, {
    discard: toBottom ? [...state.discard, iid] : [iid, ...state.discard],
    ...(holder !== undefined ? { events: [...state.events, { kind: "discarded" as const, iid, player: holder }] } : {}),
    ...(toBottom ? { log: [...state.log, `${state.instances[iid]?.cardId || iid} is placed on the bottom of the discard pile (Center Stage M)`] } : {}),
  });
}

function discardInstance(state: GameState, iid: string): GameState {
  const ph = pizzaHutCode(state, iid); // C.C.: a code counter instead of being discarded
  if (ph) return ph;
  const lr = liveRedirect(state, iid); // LIVE!: overlay onto another character instead
  if (lr) return lr;
  const ci = state.instances[iid];
  if (ci) for (const ov of ci.overlays) state = discardInstance(state, ov); // overlays leave play too
  // "if you discard this card" triggers: who held it (hand or board) discards it
  const holder = state.players.find((p) => p.hand.includes(iid) || p.board.includes(iid))?.pid;
  state = replace(state, {
    players: state.players.map((p) => ({
      ...p,
      board: p.board.filter((x) => x !== iid),
      hand: p.hand.filter((x) => x !== iid),
    })),
  });
  state = discardOrRedirect(state, iid, holder);
  if (state.instances[iid]) {
    state = updateInstance(state, iid, {
      mods: [], counters: {}, battles: 0, overlays: [], tapped: false, faceDown: false, stunned: false, ssThisTurn: false, effectsNegated: false, linkedTo: undefined, protectedFromEffects: false, pos: undefined,
    });
  }
  return state;
}

/** Compute a pending battle: tap the attacker, bump battle counters, decide who
 *  loses on EFFECTIVE stats (ATK > the other's DEF => discard). Clears
 *  pendingBattle. `resolved` is false when a participant left play first. */
/** "Noir Attack" (MJG-C29): the (up to 2) characters CLOSEST to `target` by REAL table
 *  geometry. Each board is an infinitely wide strip: page k sits k page-spans to the
 *  right, where a span = the page's occupied width (760) plus a one-card gap (100).
 *  Boards stack flush on the depth axis by seat offset FROM THE ATTACKER's
 *  perspective (the same anticlockwise offset their client places seats with:
 *  the attacker's own board is row 0, the across player the farthest). Distance is Euclidean between card CENTERS (BIG ICHIHIME's from its 2×
 *  footprint; posless legacy cards fall back to their flow slot). Candidates are every
 *  board card on every living board EXCEPT the attacked target itself — the attacker's
 *  own board and DealinDemon included. Ties at equal distance go to an OPPONENT of
 *  `attackerPid` before the attacker's own cards, then by seat then index. */
function noirVictims(state: GameState, target: string, attackerPid: Seat): string[] {
  const PAGE_SPAN = BOARD_GEOM.maxX + 2 * BOARD_GEOM.cardW; // 760 occupied + a one-card gap
  const ROW_SPAN = BOARD_GEOM.maxY + BOARD_GEOM.cardH; // one board's full depth extent
  const seating = state.seating.length ? [...state.seating] : state.players.map((p) => p.pid);
  const rowOf = (pid: Seat) => {
    const i = seating.indexOf(pid), a = seating.indexOf(attackerPid);
    return i < 0 || a < 0 ? 0 : (a - i + seating.length) % seating.length; // attacker = 0, anticlockwise
  };
  const center = (iid: string, i: number, pid: Seat): { cx: number; cy: number } | null => {
    const ci = state.instances[iid];
    if (!ci) return null;
    const pos = ci.pos ?? { x: (i % BOARD_GEOM.cols) * BOARD_GEOM.xStep, y: Math.floor(i / BOARD_GEOM.cols) * BOARD_GEOM.yStep, page: 0 };
    const big = ci.cardId === "NYA-000" ? 2 : 1;
    return {
      cx: pos.x + (pos.page ?? 0) * PAGE_SPAN + (BOARD_GEOM.cardW * big) / 2,
      cy: pos.y + rowOf(pid) * ROW_SPAN + (BOARD_GEOM.cardH * big) / 2,
    };
  };
  const tp = state.players.find((p) => p.board.includes(target));
  if (!tp) return [];
  const tc = center(target, tp.board.indexOf(target), tp.pid);
  if (!tc) return [];
  const cands: { iid: string; d2: number; opp: number; row: number; idx: number }[] = [];
  for (const p of state.players) {
    if (p.eliminated) continue;
    p.board.forEach((iid, i) => {
      if (iid === target) return; // the attacked card itself never counts
      const c = center(iid, i, p.pid);
      if (!c) return;
      cands.push({ iid, d2: (c.cx - tc.cx) ** 2 + (c.cy - tc.cy) ** 2, opp: p.pid === attackerPid ? 0 : 1, row: rowOf(p.pid), idx: i });
    });
  }
  cands.sort((a, b) => a.d2 - b.d2 || b.opp - a.opp || a.row - b.row || a.idx - b.idx);
  return cands.slice(0, 2).map((c) => c.iid);
}

function battleOutcome(state: GameState): {
  state: GameState;
  atk?: string;
  def?: string;
  defLoses: boolean;
  atkLoses: boolean;
  resolved: boolean;
} {
  const b = state.pendingBattle;
  if (b === null) return { state, defLoses: false, atkLoses: false, resolved: false };
  const { attackerId: atk, targetId: def } = b;
  // The attacker taps after attacking (it committed at declaration).
  if (atk !== undefined && state.instances[atk]) state = updateInstance(state, atk, { tapped: true });
  const onBoard = (iid: string | undefined): iid is string =>
    iid !== undefined && state.players.some((p) => p.board.includes(iid));
  if (!onBoard(atk) || !onBoard(def)) {
    state = replace(state, { pendingBattle: null });
    return {
      state: log(state, `battle ${atk} -> ${def}: no resolution (a participant left play)`),
      atk, def, defLoses: false, atkLoses: false, resolved: false,
    };
  }
  // both fought "without leaving play" -> bump battle counters
  state = updateInstance(state, atk, { battles: inst(state, atk).battles + 1 });
  state = updateInstance(state, def, { battles: inst(state, def).battles + 1 });
  // stats are read while pendingBattle is STILL SET, so battle-scoped auras
  // ("only during battles with this card" — AI Apocalypse) apply to the outcome
  const aAtk = atkOf(state, atk), aDef = defOf(state, atk);
  const dAtk = atkOf(state, def), dDef = defOf(state, def);
  const oneSided = b.oneSided === true; // defender doesn't fight back (fOUnD mEeEeee)
  // "Noir Attack" (MJG-C29): capture the cards adjacent to the target NOW (still on the board),
  // for DealinDemon's on-battle trigger to discard. Reset every battle (empty unless it attacked).
  const noirAtk = atk !== undefined && hasAbility(state, atk, "MJG-C29") && !state.instances[atk]?.faceDown && !isEffectNegated(state, atk);
  const aOwner = atk !== undefined ? state.players.find((p) => p.board.includes(atk))?.pid : undefined;
  state = replace(state, { pendingNoir: noirAtk && aOwner !== undefined ? noirVictims(state, def, aOwner) : [] });
  state = replace(state, { pendingBattle: null });
  state = log(state, `battle${oneSided ? " (one-sided)" : ""}: ${atk}(${aAtk}/${aDef}) vs ${def}(${dAtk}/${dDef})`);
  return { state, atk, def, defLoses: aAtk > dDef, atkLoses: !oneSided && dAtk > aDef, resolved: true };
}

/** Move an instance OUT of play to a non-discard zone (battle "… instead"
 *  replacement, e.g. Yuzu -> deck top), clearing leave-play state and discarding
 *  any overlays. */
function relocateInstance(state: GameState, iid: string, to: "deckTop" | "deckBottom" | "hand" | "banish"): GameState {
  const ci = state.instances[iid];
  if (ci) for (const ov of ci.overlays) state = discardInstance(state, ov); // overlays leave play too
  const owner = to === "hand" ? (state.players.find((p) => p.board.includes(iid) || p.hand.includes(iid))?.pid ?? null) : null;
  state = replace(state, {
    players: state.players.map((p) => ({ ...p, board: p.board.filter((x) => x !== iid), hand: p.hand.filter((x) => x !== iid) })),
  });
  if (to === "deckTop") state = replace(state, { mainDeck: [iid, ...state.mainDeck] });
  else if (to === "deckBottom") state = replace(state, { mainDeck: [...state.mainDeck, iid] });
  else if (to === "banish") state = replace(state, { banish: [iid, ...state.banish] });
  else if (to === "hand" && owner !== null)
    state = replace(state, { players: state.players.map((p) => (p.pid === owner ? { ...p, hand: [...p.hand, iid] } : p)) });
  if (state.instances[iid]) {
    state = updateInstance(state, iid, { mods: [], counters: {}, battles: 0, overlays: [], tapped: false, faceDown: false, stunned: false, ssThisTurn: false, effectsNegated: false, linkedTo: undefined, protectedFromEffects: false, pos: undefined });
  }
  return state;
}

/** Apply a MANDATORY battle-discard replacement to `loser`. Returns whether the
 *  loser itself was discarded (so its battleDiscard trigger fires). A replacement
 *  saves the loser — by discarding a different card, or moving it elsewhere. */
function mandatoryReplace(st: GameState, loser: string): { st: GameState; discarded: boolean } {
  const rep = BATTLE_DISCARD_REPLACER ? BATTLE_DISCARD_REPLACER(st, loser) : null;
  if (!rep) return { st: discardInstance(st, loser), discarded: true };
  if (rep.kind === "discardInstead") return { st: discardInstance(st, rep.iid), discarded: false };
  return { st: relocateInstance(st, loser, rep.to), discarded: false };
}

/** Immediate battle resolution used by `resolveChain` (resolve-all): applies
 *  MANDATORY "instead" replacements (e.g. discard Miko instead) but has no
 *  window for OPTIONAL hand-traps. The session path uses `beginBattleDiscards`. */
function resolveBattle(state: GameState): GameState {
  const o = battleOutcome(state);
  state = o.state;
  if (!o.resolved) return state;
  const atk = o.atk!, def = o.def!;
  // We're not gay! — a same-parity attack discards neither; both owners draw 1
  if (wereNotGay(state, atk, def)) {
    state = log(state, `We're not gay! — neither is discarded by battle; both owners draw 1`);
    const aOw = state.players.find((p) => p.board.includes(atk))?.pid;
    const dOw = state.players.find((p) => p.board.includes(def))?.pid;
    if (aOw !== undefined) state = drawOneByEffect(state, aOw);
    if (dOw !== undefined && dOw !== aOw) state = drawOneByEffect(state, dOw);
    return state;
  }
  // mutual destruction: defender is discarded FIRST, attacker LAST (FAQ R6).
  // A battle-discard-immune loser (Supermodel) simply stays on the board.
  let defGone = false;
  let atkGone = false;
  if (o.defLoses) {
    if (isEffectImmune(state, def)) state = log(state, `${inst(state, def).cardId || def} cannot be discarded by battle (Supermodel)`);
    else { const r = mandatoryReplace(state, def); state = r.st; defGone = r.discarded; }
  }
  if (o.atkLoses) {
    if (isEffectImmune(state, atk)) state = log(state, `${inst(state, atk).cardId || atk} cannot be discarded by battle (Supermodel)`);
    else { const r = mandatoryReplace(state, atk); state = r.st; atkGone = r.discarded; }
  }
  const ownerOnBoard = (iid: string): Seat | null =>
    state.players.find((p) => p.board.includes(iid))?.pid ?? null;
  const emit: TriggerEvent[] = [];
  if (defGone) {
    const ow = ownerOnBoard(atk);
    if (ow !== null) emit.push({ kind: "battleDiscard", discarder: atk, discarded: def, player: ow });
  }
  if (atkGone) {
    const ow = ownerOnBoard(def);
    if (ow !== null) emit.push({ kind: "battleDiscard", discarder: def, discarded: atk, player: ow });
  }
  if (defGone || atkGone) state = replace(state, { battleDiscardedThisTurn: true });
  emit.push({ kind: "battle", atk, def }); // "after this card battles" (MJG-C28), board now settled
  if (emit.length) state = replace(state, { events: [...state.events, ...emit] });
  return state;
}

/** Session path: the battle declaration window has closed. Compute the battle;
 *  MANDATORY board replacements (Miko bottom) discard their substitute now and
 *  save the loser, while remaining losers go to `pendingDiscards` and a
 *  RESPONSE_WINDOW opens so OPTIONAL "instead" hand-traps (Miko top) can respond.
 *  If nothing is left to discard, go straight to the post-battle window. */
function beginBattleDiscards(state: GameState): GameState {
  const o = battleOutcome(state);
  state = o.state;
  if (!o.resolved) return openWindow(state, [], Phase.MAIN_PHASE);
  const atk = o.atk!, def = o.def!;
  // We're not gay! — a same-parity attack discards neither; both owners draw 1
  if (wereNotGay(state, atk, def)) {
    state = log(state, `We're not gay! — neither is discarded by battle; both owners draw 1`);
    const aOw = state.players.find((p) => p.board.includes(atk))?.pid;
    const dOw = state.players.find((p) => p.board.includes(def))?.pid;
    if (aOw !== undefined) state = drawOneByEffect(state, aOw);
    if (dOw !== undefined && dOw !== aOw) state = drawOneByEffect(state, dOw);
    state = replace(state, { events: [...state.events, { kind: "battle", atk, def }] }); // they still battled (MJG-C28)
    return openWindow(state, [], Phase.MAIN_PHASE); // straight to the post-battle window
  }
  const losers: { iid: string; by: string }[] = [];
  if (o.defLoses) losers.push({ iid: def, by: atk }); // defender first (FAQ R6)
  if (o.atkLoses) losers.push({ iid: atk, by: def });
  const pending: { iid: string; by: string }[] = [];
  for (const L of losers) {
    if (isEffectImmune(state, L.iid)) {
      state = log(state, `${inst(state, L.iid).cardId || L.iid} cannot be discarded by battle (Supermodel)`);
      continue; // it never enters the discard window
    }
    const rep = BATTLE_DISCARD_REPLACER ? BATTLE_DISCARD_REPLACER(state, L.iid) : null;
    if (rep?.kind === "discardInstead") state = discardInstance(state, rep.iid); // mandatory: discard substitute
    else if (rep?.kind === "moveInstead") state = relocateInstance(state, L.iid, rep.to); // mandatory: relocate loser (Yuzu)
    else pending.push(L); // no mandatory replacement -> open the discard window for optional hand-traps
  }
  state = replace(state, { pendingDiscards: pending });
  if (pending.length === 0) {
    // no discard window needed — emit the battle event now (board already settled)
    state = replace(state, { events: [...state.events, { kind: "battle", atk, def }] });
    return openWindow(state, [], Phase.MAIN_PHASE);
  }
  // Open the battle-discard window. windowReturn stays null so closeWindow's
  // pendingDiscards branch finalizes it once all responses are done.
  state = replace(state, {
    phase: Phase.RESPONSE_WINDOW,
    windowActivator: null,
    prioritySeat: state.activePlayer,
    windowReturn: null,
  });
  return log(state, `battle discard window opens (${pending.length} pending); priority->${state.activePlayer}`);
}

/** Discard the battle losers that survived the discard window (i.e. were not
 *  saved by an "instead" effect), emitting battleDiscard triggers for any
 *  discarder still on the board. */
function finalizeBattleDiscards(state: GameState): GameState {
  const pd = state.pendingDiscards;
  state = replace(state, { pendingDiscards: [] });
  const onBoard = (iid: string): boolean => state.players.some((p) => p.board.includes(iid));
  const emit: TriggerEvent[] = [];
  let any = false;
  for (const { iid, by } of pd) {
    if (!onBoard(iid)) continue; // already left play (saved/moved by a response)
    state = discardInstance(state, iid);
    // a mandatory replacement (LIVE! overlay / C.C. code / Center Stage K shuffle) may
    // have SAVED it — it was only "discarded by battle" if it actually reached the pile
    if (!state.discard.includes(iid)) continue;
    any = true;
    const ow = state.players.find((p) => p.board.includes(by))?.pid ?? null;
    if (ow !== null) emit.push({ kind: "battleDiscard", discarder: by, discarded: iid, player: ow });
  }
  if (any) state = replace(state, { battleDiscardedThisTurn: true });
  // "after this card battles" (MJG-C28): the two participants are the loser + its
  // discarder; pd[0] carries both even for mutual destruction. Emitted now (after the
  // discards) so the trigger sees the settled board.
  if (pd[0]) emit.push({ kind: "battle", atk: pd[0].by, def: pd[0].iid });
  if (emit.length) state = replace(state, { events: [...state.events, ...emit] });
  return log(state, `battle discards finalized (${pd.length})`);
}

/** Advance the forced-discard queue: prune cards that already left play, drop
 *  emptied groups, and either hand control to the next owner (FORCED_DISCARD) or,
 *  when the queue is empty, return to the main phase. */
function enterForcedDiscard(state: GameState): GameState {
  const q = state.pendingForcedDiscards
    .map((g) => {
      const board = state.players.find((p) => p.pid === g.player)?.board ?? [];
      return { player: g.player, iids: g.iids.filter((iid) => board.includes(iid)) };
    })
    .filter((g) => g.iids.length > 0);
  state = replace(state, { pendingForcedDiscards: q, windowActivator: null, prioritySeat: null });
  if (q.length === 0) return replace(state, { phase: Phase.MAIN_PHASE });
  state = replace(state, { phase: Phase.FORCED_DISCARD });
  return log(state, `forced discard: player ${q[0]!.player} discards ${q[0]!.iids.length} card(s), one at a time`);
}

function enterDiscardOrEnd(state: GameState): GameState {
  // Diabolus ex Machina (MJG-C07): a scheduled "shuffle your hand into the deck" runs
  // BEFORE the hand-size check, so a full hand returns to the deck (not the discard pile).
  if (state.pendingHandShuffle.includes(state.activePlayer)) {
    const me = state.activePlayer;
    const p = player(state, me);
    if (p.hand.length > 0) {
      const sh = shuffleWith(state.rngState, [...state.mainDeck, ...p.hand]);
      state = replace(state, { rngState: sh.state, mainDeck: sh.value });
      state = replacePlayer(state, replace(player(state, me), { hand: [] }));
      state = log(state, `player ${me} shuffles their hand into the deck (Diabolus ex Machina)`);
    }
    state = replace(state, { pendingHandShuffle: state.pendingHandShuffle.filter((x) => x !== me) });
  }
  const ap = player(state, state.activePlayer);
  // Over the limit, but a Brick ([B]) can't be discarded — only force DiscardDown while a
  // discardable (non-Brick) card remains; an all-Brick hand simply stays over the limit.
  if (ap.hand.length > HAND_LIMIT && ap.hand.some((iid) => !isBrick(state.instances[iid]?.cardId))) {
    state = replace(state, { phase: Phase.DISCARD_DOWN });
    return log(state, `hand ${ap.hand.length} > ${HAND_LIMIT} -> DiscardDown`);
  }
  // the player is now ENDING their turn: flip back "until the end of this turn"
  // cards (Trap Trick), lapse their scheduled stuns, and return their Lead
  // Character stashes (the overlay back to the hand, the host stays)
  const me = state.activePlayer;
  for (const u of state.pendingUnflips) {
    if (u.player !== me || u.until !== "endOfThisTurn") continue;
    const ci = state.instances[u.iid];
    // Book of Eclipse (MJG-C15) suppresses scheduled flip-backs (see checkBookOfEclipse).
    if (ci?.faceDown && state.players.some((p) => p.board.includes(u.iid)) && !bookOfEclipseActive(state)) {
      state = updateInstance(state, u.iid, { faceDown: false });
      state = log(state, `${ci.cardId || u.iid} flips face-up (end of player ${me}'s turn)`);
    }
  }
  for (const u of state.pendingUnstuns) {
    if (u.player !== me || u.skip) continue; // `skip`: defer one end-of-turn (until the NEXT turn)
    const ci = state.instances[u.iid];
    if (ci?.stunned) {
      state = updateInstance(state, u.iid, { stunned: false });
      state = log(state, `${ci.cardId || u.iid} is no longer stunned`);
    }
  }
  for (const r of state.pendingOverlayReturns) {
    if (r.player !== me) continue;
    if (r.cover) {
      // Lead Character: the COVERING card returns to the hand; the covered host pops
      // back onto the board (in the same slot) with the remaining materials.
      const top = state.instances[r.card];
      const owner = state.players.find((p) => p.board.includes(r.card))?.pid;
      if (!top || owner === undefined || !top.overlays.includes(r.host)) continue; // cover left play -> lapses
      const rest = top.overlays.filter((x) => x !== r.host);
      state = replace(state, {
        players: state.players.map((p) => (p.pid === owner ? { ...p, board: p.board.map((x) => (x === r.card ? r.host : x)) } : p)),
      });
      state = updateInstance(state, r.host, { overlays: [...(state.instances[r.host]?.overlays ?? []), ...rest], pos: top.pos });
      // the returning card leaves play: shed all in-play state (FAQ R46)
      state = updateInstance(state, r.card, {
        overlays: [], mods: [], counters: {}, battles: 0, tapped: false, faceDown: false, stunned: false, ssThisTurn: false, effectsNegated: false, linkedTo: undefined, protectedFromEffects: false, pos: undefined,
      });
      const pl = player(state, me);
      state = replacePlayer(state, replace(pl, { hand: [...pl.hand, r.card] }));
      state = log(state, `${top.cardId || r.card} returns to player ${me}'s hand — ${state.instances[r.host]?.cardId || r.host} stays on board (Lead Character)`);
      continue;
    }
    const host = state.instances[r.host];
    if (!host || !host.overlays.includes(r.card) || !state.players.some((p) => p.board.includes(r.host))) continue;
    state = updateInstance(state, r.host, { overlays: host.overlays.filter((x) => x !== r.card) });
    const pl = player(state, me);
    state = replacePlayer(state, replace(pl, { hand: [...pl.hand, r.card] }));
    state = log(state, `${state.instances[r.card]?.cardId || r.card} returns to player ${me}'s hand (Lead Character)`);
  }
  // "discard it at the end of this turn" (Sacred Enjou): discard the borrowed cards still in play
  for (const d of state.pendingEndTurnDiscards) {
    if (d.player !== me) continue;
    if (state.players.some((p) => p.board.includes(d.iid))) state = discardInstance(state, d.iid);
  }
  // "Snake Bite": the poison lasts only "during their next turn" — consume the counters
  // as that turn ends.
  if (state.poisonActive.includes(me)) {
    const pl = player(state, me);
    state = replacePlayer(state, replace(pl, { counters: { ...pl.counters, poison: 0 } }));
  }
  // "Ashes" unlimited-summon window: ends at the END of its owner's NEXT turn (skip the
  // first end-of-turn, which is the turn it was activated on).
  const us = state.unlimitedSummon;
  const nextUnlimited = us === null || us.player !== me ? us : us.skip ? { ...us, skip: false } : null;
  state = replace(state, {
    unlimitedSummon: nextUnlimited,
    phase: Phase.TURN_END,
    pendingUnflips: state.pendingUnflips.filter((u) => !(u.player === me && u.until === "endOfThisTurn")),
    // drop the ones that lapsed; a `skip` entry survives this turn-end with skip cleared
    pendingUnstuns: state.pendingUnstuns.flatMap((u) =>
      u.player !== me ? [u] : u.skip ? [{ ...u, skip: false }] : []),
    pendingOverlayReturns: state.pendingOverlayReturns.filter((r) => r.player !== me),
    pendingEndTurnDiscards: state.pendingEndTurnDiscards.filter((d) => d.player !== me),
    poisonActive: state.poisonActive.filter((p) => p !== me),
  });
  return log(state, `hand ${ap.hand.length} <= ${HAND_LIMIT} -> TurnEnd`);
}

// ---- hand helpers -----------------------------------------------------------
/** Index of cardId in hand, or last index as fallback (preserves count-based
 *  discard for opaque/unspecified ids); -1 only if hand is empty. */
function pickFromHand(hand: readonly string[], cardId: string | undefined): number {
  if (cardId !== undefined && hand.includes(cardId)) return hand.indexOf(cardId);
  return hand.length ? hand.length - 1 : -1;
}
function removeAt(hand: readonly string[], idx: number): string[] {
  if (idx < 0) return [...hand];
  return [...hand.slice(0, idx), ...hand.slice(idx + 1)];
}

// ---- game construction ------------------------------------------------------
export type DeckSpec = number | string[];

function makeInstance(iid: string, cardId: string): CardInstance {
  const c = cardData(cardId);
  const value = c ? (c.star ? null : (c.value ?? 0)) : 0;
  return {
    iid,
    cardId,
    atk: c?.atk ?? 0,
    def: c?.def ?? 0,
    value,
    tribes: c?.tribes ? [...c.tribes] : [],
    faceDown: false,
    tapped: false,
    counters: {},
    overlays: [],
    battles: 0,
    mods: [],
  };
}

/** "Snake Bite" (MJG-048): the poisoned player discards 1 RANDOM hand card per poison
 *  counter whenever they PLAY a card (Normal Summon / Special Summon / Spell or Faith
 *  activation). `exclude` = the card(s) being played (never self-discarded). A randomly
 *  picked Brick is revealed instead of discarded (Bricks only leave a hand at random). */
export function chargePoison(state: GameState, pid: Seat, exclude: ReadonlySet<string>): GameState {
  if (!state.poisonActive.includes(pid)) return state;
  const pc = player(state, pid).counters["poison"] ?? 0;
  const pool = player(state, pid).hand.filter((iid) => !exclude.has(iid));
  const n = Math.min(pc, pool.length);
  if (n <= 0) return state;
  const sh = shuffleWith(state.rngState, [...pool]);
  state = replace(state, { rngState: sh.state });
  let discarded = 0;
  for (let i = 0; i < n; i++) {
    const iid = sh.value[i]!;
    if (isBrick(state.instances[iid]?.cardId)) { // random pick -> a Brick is revealed, not discarded
      state = log(state, `${state.instances[iid]?.cardId ?? iid} is revealed — cannot be discarded from the hand (Brick)`);
      continue;
    }
    state = discardInstance(state, iid);
    discarded++;
  }
  if (discarded > 0) state = log(state, `player ${pid} discards ${discarded} card(s) (Snake Bite poison)`);
  return state;
}

/** Mint a fresh instance of `cardId` (e.g. a token like BIG ICHIHIME that lives in no
 *  deck) with a unique iid, adding it to the instance pool. Deterministic: the iid
 *  derives from the pool size (instances are never removed from the pool). */
export function mintInstance(state: GameState, cardId: string): { state: GameState; iid: string } {
  let n = Object.keys(state.instances).length;
  let iid = `tok-${n}`;
  while (state.instances[iid]) iid = `tok-${++n}`;
  return { state: setInstance(state, { ...makeInstance(iid, cardId), token: true }), iid };
}

/** Free-board geometry (logical units): a card is 100×139; a page row fits 7 cards
 *  laid edge to edge (x step 100 = one card wide); when a row fills, placement
 *  restarts at the left ~¼ card lower (y step 35), overlapping freely. Pages are
 *  only ever added manually. */
export const BOARD_GEOM = { cardW: 100, cardH: 139, cols: 7, xStep: 100, yStep: 35, maxX: 660, maxY: 105, pageCap: 9 } as const;

/** Explosive Aria (MSGK-C30): which of `board`'s cards does a standard card PLACED
 *  at (x, y) on `page` touch? STRICT rect overlap — flush edges do not count.
 *  Posless (legacy) cards fall back to their flow slot, same as the client. */
export function ariaTouches(state: GameState, board: Seat, x: number, y: number, page: number): string[] {
  const foot = (id: string | null | undefined) =>
    id === "NYA-000" ? { w: BOARD_GEOM.cardW * 2, h: BOARD_GEOM.cardH * 2 } : { w: BOARD_GEOM.cardW, h: BOARD_GEOM.cardH };
  const pw = BOARD_GEOM.cardW, ph = BOARD_GEOM.cardH;
  const cards = state.players.find((p) => p.pid === board)?.board ?? [];
  return cards.filter((b, i) => {
    const ci = state.instances[b];
    const pos = ci?.pos ?? { x: (i % BOARD_GEOM.cols) * BOARD_GEOM.xStep, y: Math.floor(i / BOARD_GEOM.cols) * BOARD_GEOM.yStep, page: 0 };
    if ((pos.page ?? 0) !== page) return false;
    const f = foot(ci?.cardId);
    return x < pos.x + f.w && x + pw > pos.x && y < pos.y + f.h && y + ph > pos.y;
  });
}

/** Assign `iid` (just added to `pid`'s board) its table position: the next flow slot
 *  on the page its owner is viewing. Kept until leave-play or an owner drag. */
export function assignBoardPos(state: GameState, pid: Seat, iid: string): GameState {
  if (!state.instances[iid]) return state;
  const pl = player(state, pid);
  const page = Math.max(0, Math.min(state.boardView[pid] ?? 0, (pl.boardPages ?? 1) - 1));
  const n = pl.board.filter((b) => b !== iid && (state.instances[b]?.pos?.page ?? 0) === page).length;
  const col = n % BOARD_GEOM.cols;
  const row = Math.floor(n / BOARD_GEOM.cols);
  return updateInstance(state, iid, { pos: { x: col * BOARD_GEOM.xStep, y: Math.min(row * BOARD_GEOM.yStep, BOARD_GEOM.maxY), page } });
}

/**
 * Build a fresh game with SHARED Main/Faith decks.
 *
 * - players: seat ids in CLOCKWISE seating order; players[0] is the first player.
 * - mainDeck / faithDeck: either a number (that many opaque instances, no card
 *   identity) or a list of card ids (identity-bearing). Index 0 = top of deck.
 * - Starting hands are dealt one-at-a-time, anticlockwise from the first player
 *   (FAQ R36), off the top of the Main deck.
 */
export function newGame(opts: {
  players: Seat[];
  mainDeck: DeckSpec;
  faithDeck?: DeckSpec;
  startingHand?: number;
  registry?: Record<string, Ability>;
  cardRegistry?: Card[] | Record<string, Card>;
  seed?: number; // PRNG seed for in-effect randomness (replayability)
}): GameState {
  const startingHand = opts.startingHand ?? 5;
  if (opts.cardRegistry !== undefined) setCardRegistry(opts.cardRegistry);
  if (opts.registry !== undefined) setRegistry(opts.registry);

  const instances: Record<string, CardInstance> = {};
  let counter = 0;
  const buildZone = (deck: DeckSpec, tag: string): string[] => {
    const ids: string[] = [];
    const n = typeof deck === "number" ? deck : deck.length;
    for (let k = 0; k < n; k++) {
      const iid = `${tag}-${counter++}`;
      const cardId = typeof deck === "number" ? "" : deck[k]!;
      instances[iid] = makeInstance(iid, cardId);
      ids.push(iid);
    }
    return ids;
  };

  let mainDeck = buildZone(opts.mainDeck, "m");
  const faithDeck = buildZone(opts.faithDeck ?? 0, "f");

  const players: PlayerState[] = opts.players.map((pid) => ({
    pid,
    hand: [],
    board: [],
    meldZone: [],
    eliminated: false,
    summonedThisTurn: false,
    meldedThisTurn: false,
    actedThisTurn: false,
    counters: {},
    boardPages: 1,
  }));
  // deal one-at-a-time, anticlockwise from the first player
  const first = opts.players[0]!;
  const dealOrder = RU.seatOrder(opts.players, first);
  const hands = new Map<Seat, string[]>(opts.players.map((pid) => [pid, []]));
  for (let r = 0; r < startingHand; r++) {
    for (const pid of dealOrder) {
      if (mainDeck.length === 0) break;
      hands.get(pid)!.push(mainDeck[0]!);
      mainDeck = mainDeck.slice(1);
    }
  }
  const finalPlayers = players.map((p) => ({ ...p, hand: hands.get(p.pid)! }));
  // the opening hand counts as drawn: "when you draw this card" triggers (e.g. Banana)
  // fire for starting-hand cards too, processed during begin()'s starting-hands window.
  // Flagged `opening` so opponent-draw hand-traps (fOUnD mEeEeee) DON'T chain to every
  // dealt card — those only respond from the first draw-for-turn onwards.
  const startDraws: TriggerEvent[] = finalPlayers.flatMap((p) => p.hand.map((iid) => ({ kind: "draw" as const, iid, player: p.pid, opening: true })));

  return {
    phase: Phase.TURN_START_DRAW,
    activePlayer: first,
    players: finalPlayers,
    chain: [],
    pendingBattle: null,
    pendingDiscards: [],
    pendingMeld: null,
    pendingForcedDiscards: [],
    pendingLivePlacements: [],
    pendingUnflips: [],
    pendingSkips: [],
    deckFlipped: false,
    eclipseActive: false,
    heavensGateLatch: false,
    pendingImmunityEnds: [],
    pendingUnstuns: [],
    pendingOverlayReturns: [],
    pendingEndTurnDiscards: [],
    unlimitedSummon: null,
    pendingStartTurnSummons: [],
    pendingPoison: [],
    poisonActive: [],
    pendingTurnControl: [],
    geassTargets: [],
    turnControlledBy: null,
    announcedSummon: null,
    pendingEndTurn: null,
    pendingNoir: [],
    pendingEffectDiscards: [],
    handRevealedTo: [],
    matchmakerBonds: [],
    boardView: {},
    effectLockBy: null,
    effectActsThisTurn: [],
    pendingHandShuffle: [],
    battleDiscardedThisTurn: false,
    resumePhase: null,
    log: [],
    seating: [...opts.players],
    prioritySeat: null,
    windowActivator: null,
    windowReturn: null,
    usage: {},
    winner: null,
    rngState: (opts.seed ?? 0x12345678) >>> 0,
    mainDeck,
    faithDeck,
    discard: [],
    banish: [],
    extraZone: [],
    instances,
    events: startDraws,
  };
}
