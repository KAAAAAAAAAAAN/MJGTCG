/**
 * MJGTCG rules layer — legality & ordering on top of the reducer.
 *
 * Ported from the Python reference `rules.py`. Pure functions; consumes the
 * parsed PSCT trees (base_set_parsed.json) and feeds decisions to the reducer.
 *
 * RULINGS
 * -------
 * 1. Priority passes ANTICLOCKWISE relative to the player who activated the
 *    effect. If the activator is indeterminate -> assume the turn player.
 *    2-player games are strict alternation.
 * 2. Only (At any time) abilities may be ACTIVELY chained (MJGTCG's quick
 *    effects). The marker is the literal "(At any time)" parenthetical in the
 *    ability TEXT -- NOT the card category. Category S/A/P/F/B is
 *    Spell/Active/Passive/Faith/Brick; a category-'S' is NOT automatically a
 *    quick effect. Any ability without (At any time) can only enter a chain as
 *    a TRIGGER effect (simultaneous triggers resolve SEGOC-style).
 * 3. KAN resolves IMMEDIATELY. The declaration itself is NOT a response window.
 * 4. The Faith Deck is only accessible AFTER a meld, unless an effect explicitly
 *    states/requires it. Bare "Deck" / "search the deck" = BASE DECK only.
 * 5. Simultaneous triggers order SEGOC-style: the turn player's triggers go on
 *    the chain first, then anticlockwise.
 */

export type Seat = number;

export interface Ability {
  type?: string; // card category S/A/P/F/B (used by restriction/lock auras)
  parsed?: {
    flags?: Record<string, boolean>;
    clauses?: string[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface Trigger {
  player: Seat;
  id?: string;
  // optional effect-script reference so a trigger link runs its card script
  // when it resolves (controller is taken from `player`). `targets` carries any
  // choice locked in when the (optional) trigger was placed.
  script?: { cardId: string; role: string; self: string; targets?: string[]; drewBy?: Seat };
  [k: string]: unknown;
}

/** {scope: {key: count}} — keys are produced by usageKey(). */
export type UsageLedger = Record<string, Record<string, number>>;

// NOTE: card categories are S/A/P/F/B. "Quick speed" is decided by the
// (At any time) TEXT flag, parsed into ability.parsed.flags.at_any_time --
// see canActivelyChain(). QUICK_TYPE is the category label for display only;
// it MUST NOT be used to infer chainability.
export const QUICK_TYPE = "S";

// ---- Ruling 1 & 5 : anticlockwise priority order ---------------------------
/**
 * Player ids in anticlockwise priority order starting AFTER the activator.
 * playerIds: seat ids in clockwise seating order. Returns the activator first
 * (they hold priority), then each other seat anticlockwise (reverse of CW).
 */
export function seatOrder(playerIds: Iterable<Seat>, activator: Seat): Seat[] {
  const seats = [...playerIds];
  const i = seats.indexOf(activator);
  if (i < 0) throw new Error(`activator ${activator} not seated`);
  const n = seats.length;
  // anticlockwise step = -1 in clockwise list
  return Array.from({ length: n }, (_, k) => seats[(((i - k) % n) + n) % n]!);
}

/**
 * Order in which players GET to respond, per Ruling 1.
 * activator may be null (indeterminate) -> fall back to the turn player.
 */
export function priorityAfter(
  playerIds: Iterable<Seat>,
  activator: Seat | null,
  turnPlayer: Seat,
): Seat[] {
  const ref = activator !== null ? activator : turnPlayer;
  return seatOrder(playerIds, ref);
}

// ---- Ruling 2 : what may be actively chained -------------------------------
/**
 * True iff this ability may be voluntarily activated in a response window.
 * Only (At any time) abilities qualify (parsed flag is the source of truth).
 */
export function canActivelyChain(ability: Ability): boolean {
  const flags = ability.parsed?.flags ?? {};
  return Boolean(flags["at_any_time"]);
}

export function isTriggerOnly(ability: Ability): boolean {
  return !canActivelyChain(ability);
}

// ---- Ruling 5 : simultaneous trigger ordering (SEGOC) ----------------------
/**
 * Order a batch of triggers that fired at the same time. Turn player's triggers
 * first, then anticlockwise. Stable within a player (preserve input order).
 * Returns the trigger INDICES in resolution order.
 */
export function orderSimultaneousTriggers(
  triggers: Trigger[],
  playerIds: Iterable<Seat>,
  turnPlayer: Seat,
): number[] {
  const order = seatOrder(playerIds, turnPlayer); // turn player first, anticlockwise
  const rank = new Map<Seat, number>();
  order.forEach((pid, k) => rank.set(pid, k));
  return triggers
    .map((_, idx) => idx)
    .sort((a, b) => {
      const ra = rank.get(triggers[a]!.player)!;
      const rb = rank.get(triggers[b]!.player)!;
      return ra !== rb ? ra - rb : a - b; // stable tiebreak by index
    });
}

// ---- Ruling 3 : KAN flow ----------------------------------------------------
/** The KAN DECLARATION is not chainable. */
export function kanOpensResponseWindow(): boolean {
  return false;
}

/**
 * Given the events a KAN produces (it resolves, player draws), return the
 * trigger labels that may now chain in the open game state.
 */
export function kanResolutionTriggers(events: Record<string, boolean>): string[] {
  const out: string[] = [];
  if (events["kan"]) out.push("when_you_kan");
  if (events["opponent_drew"]) out.push("when_opponent_draws");
  if (events["self_drew"]) out.push("when_you_draw");
  return out;
}

// ---- Ruling 4 : deck access -------------------------------------------------
/**
 * Which deck an effect touches. Bare "Deck"/"search the deck" -> BASE. Faith
 * only if the effect names it, an effect requires it, or it is explicit.
 */
export function resolveDeckTarget(
  text: string,
  opts: { afterMeld?: boolean; explicitFaith?: boolean; requiresFaith?: boolean } = {},
): "base" | "faith" {
  const t = (text || "").toLowerCase();
  const namesFaith =
    t.includes("faith deck") || Boolean(opts.explicitFaith) || Boolean(opts.requiresFaith);
  if (namesFaith) {
    if (opts.requiresFaith || opts.explicitFaith || t.includes("faith deck")) return "faith";
  }
  return "base";
}

/** Gate for touching the Faith Deck at all (Ruling 4). */
export function faithDeckAccessible(opts: {
  afterMeld: boolean;
  effectRequires?: boolean;
  effectExplicit?: boolean;
}): boolean {
  return Boolean(opts.afterMeld || opts.effectRequires || opts.effectExplicit);
}

/**
 * Next seat anticlockwise from `current`, skipping eliminated seats.
 * seating: seat ids in CLOCKWISE order. living: optional set of seats still in
 * the game (eliminated seats skipped). Used for BOTH turn advancement and
 * priority so the two can never diverge.
 */
export function nextSeatAnticlockwise(
  seating: Iterable<Seat>,
  current: Seat,
  living?: Iterable<Seat> | null,
): Seat {
  const seats = [...seating];
  const idx = seats.indexOf(current);
  if (idx < 0) throw new Error(`current ${current} not seated`);
  const alive = new Set<Seat>(living == null ? seats : living);
  if (alive.size === 0) return current;
  const n = seats.length;
  for (let k = 1; k <= n; k++) {
    const cand = seats[(((idx - k) % n) + n) % n]!;
    if (alive.has(cand)) return cand;
  }
  return current;
}

// ---- Once-per-X activation limits ------------------------------------------
// Scope keys: "once_per_turn" (reset each turn), "once_per_game" (never reset),
// "once_per_player" (never reset; counted PER responding player).
const ONCE_CLAUSE_RE = /once per (turn|game|player)/i;

export type OnceScope = "once_per_turn" | "once_per_game" | "once_per_player";

/**
 * Return the once-per-X scope of an ability, or null if unlimited. Reads parsed
 * flags first, falling back to scanning the raw leading clauses.
 */
export function onceScope(ability: Ability): OnceScope | null {
  const parsed = ability.parsed ?? {};
  const flags = parsed.flags ?? {};
  if (flags["once_per_turn"]) return "once_per_turn";
  if (flags["once_per_game"]) return "once_per_game";
  if (flags["once_per_player"]) return "once_per_player";
  for (const cl of parsed.clauses ?? []) {
    const m = ONCE_CLAUSE_RE.exec(cl || "");
    if (m) return ("once_per_" + m[1]!.toLowerCase()) as OnceScope;
  }
  return null;
}

/**
 * Ledger key for a use of `abilityId` under `scope`. once_per_player is tracked
 * per (ability, player); the others are global to the ability id.
 */
export function usageKey(abilityId: string, scope: OnceScope, player: Seat): string {
  if (scope === "once_per_player") return `${abilityId} ${player}`;
  return abilityId;
}

/** Enforce once-per-turn / once-per-game / once-per-player. */
export function canActivateOnce(
  ability: Ability,
  abilityId: string,
  player: Seat,
  usage: UsageLedger,
): boolean {
  const scope = onceScope(ability);
  if (scope === null) return true;
  const key = usageKey(abilityId, scope, player);
  const used = usage[scope]?.[key] ?? 0;
  return used < 1;
}

/**
 * Return a NEW usage ledger reflecting one activation. Pure: does not mutate
 * `usage`. Equivalent copy for unlimited abilities.
 */
export function recordUse(
  ability: Ability,
  abilityId: string,
  player: Seat,
  usage: UsageLedger,
): UsageLedger {
  const next: UsageLedger = {};
  for (const [k, v] of Object.entries(usage ?? {})) next[k] = { ...v };
  const scope = onceScope(ability);
  if (scope === null) return next;
  const key = usageKey(abilityId, scope, player);
  const bucket = (next[scope] ??= {});
  bucket[key] = (bucket[key] ?? 0) + 1;
  return next;
}

/**
 * Clear once-per-turn counters (called on turn advance). once_per_game and
 * once_per_player persist. Returns a NEW ledger.
 */
export function resetTurnUsage(usage: UsageLedger): UsageLedger {
  const next: UsageLedger = {};
  for (const [k, v] of Object.entries(usage ?? {})) {
    if (k !== "once_per_turn") next[k] = { ...v };
  }
  return next;
}
