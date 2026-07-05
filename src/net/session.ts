/**
 * MJGTCG session + per-seat redaction (transport-agnostic).
 *
 * The authoritative GameState lives server-side; clients must never receive
 * hidden info (opponents' hands, deck contents/order, face-down identities).
 * `redactFor(state, seat)` produces the serializable view a given seat is
 * allowed to see. `GameSession` holds the state and applies seat-authorized
 * actions via the engine reducer. A Colyseus room (next slice) wraps this.
 */
import * as M from "../engine/reducer.js";
import type { GameState, Action, CardInstance } from "../engine/reducer.js";
import { seatOrder, orderSimultaneousTriggers, type Seat, type Trigger } from "../engine/rules.js";
import { nextInt, shuffleWith } from "../engine/rng.js";
import { canRespond, legalActions, ACTIVATIONS, RESOLVE_CHOICES, ACTIVATION_CHOICES, characterTargets, activeRoles, serialFormable, serialPicks, idCode, isUploadable, FAITH_DECK, type LegalAction } from "../engine/legal.js";
import { collectEndOfTurnTriggers, collectTriggers } from "../engine/triggers.js";
import { getTrigger, triggerTargets, triggerNeedsTargets, getSteps } from "../engine/card-scripts.js";
import { applyIntent } from "../engine/effects.js";

// ---- client-facing view types ----------------------------------------------
export interface CardView {
  iid: string;
  cardId: string | null; // null = hidden identity (opponent hand / face-down)
  atk?: number;
  def?: number;
  value?: number | null;
  tribes?: readonly string[];
  tapped?: boolean;
  stunned?: boolean; // cannot attack or use ACTIVE effects (Ear Rape)
  unattackable?: boolean; // cannot be attacked (Cupid Doesn't Exist) — not a legal battle target
  faceDown?: boolean;
  counters?: Readonly<Record<string, number>>;
  token?: boolean; // minted by an effect (BIG ICHIHIME) — not a real card
  pos?: { x: number; y: number; page: number }; // free table position (logical units) + owner's page
  overlays?: number; // count badge
  overlaid?: CardView[]; // the overlay materials beneath this card (public — they came off a board)
}
export interface MeldView {
  kind: "sequence" | "triplet" | "single"; // "single" = a one-card completed meld (Ravioli)
  kan: boolean;
  cards: CardView[]; // melded cards are public (face-up)
  values?: number[]; // resolved per-card VALUE when ☆ materials were pinned (aligned with cards)
}
export interface PlayerView {
  pid: Seat;
  eliminated: boolean;
  handCount: number;
  hand?: CardView[]; // present only for the viewer
  board: CardView[];
  meldZone: MeldView[];
  counters?: Record<string, number>; // player-level counters (poison, Clown) — public
  poison?: "armed" | "active"; // Snake Bite: poisoned from their NEXT turn / THIS turn
  boardPages: number; // board pages this player has (the "+" pager button adds more)
}
/** A link on the chain, public to everyone — an activated card's identity becomes
 *  public knowledge the moment it's activated (like Yu-Gi-Oh). */
export interface StackEntry {
  controller: Seat;
  effectId: string;
  card: CardView; // the activated card, revealed
  targets: string[]; // its locked targets (card iids / seat ids)
}
export interface ClientView {
  viewer: Seat;
  phase: string;
  activePlayer: Seat;
  prioritySeat: Seat | null;
  winner: Seat | null;
  chainDepth: number;
  stack: StackEntry[]; // the chain, public (activated cards are revealed); bottom -> top
  pendingEvents: number;
  seating: readonly Seat[];
  mainDeckCount: number;
  // the Main deck's top card, when public: upside-down (MJG-028) or Doxxed (MJG-047)
  deckTop: CardView | null;
  deckFlipped: boolean; // Right-to-Left is active (the pile is physically upside-down)
  faithDeckCount: number;
  // the Faith deck's top card, when public (Doxxed)
  faithTop: CardView | null;
  // hands shown to THIS viewer (Collusion) — until the turn change
  revealedHands: { owner: Seat; cards: CardView[] }[];
  // Matchmaker (My /mjg/ Crush) bonded pairs — public: can't attack each other, shared discard fate
  bonds: { a: string; b: string }[];
  discard: CardView[]; // public, ordered (index 0 = top)
  banish: CardView[]; // public
  extraZone: CardView[]; // Catbox "Upload": face-up cards whose Active all players may use
  players: PlayerView[];
  log: string[]; // recent tail
  // Public "in-flight" targeting, so every player can see what a pending attack or
  // chained effect is aimed at and decide whether to respond.
  pending: {
    battle: { attacker: string; target: string } | null; // declared attack (attacker -> target)
    targets: string[]; // card iids targeted by effects currently on the chain
    targetSeats: Seat[]; // players targeted by effects on the chain (e.g. Dnruk)
    discards: string[]; // card iids about to be discarded by battle (the discard window)
    meld: { player: Seat; cards: CardView[]; values?: number[] } | null; // a declared meld awaiting its window (materials revealed)
  };
}

/** Hand iids a player may CHOOSE to discard/banish. Bricks ([B]) are never valid picks —
 *  they can only be hit at random (and are revealed then). See The Brick (MJG-C16). */
const choosableHand = (state: GameState, iids: readonly string[]): string[] =>
  iids.filter((iid) => !M.isBrick(state.instances[iid]?.cardId));

// ---- redaction --------------------------------------------------------------
function visibleCard(state: GameState, iid: string): CardView {
  const ci = state.instances[iid] as CardInstance | undefined;
  if (!ci) return { iid, cardId: null };
  return {
    iid,
    cardId: ci.cardId || null,
    atk: M.atkOf(state, iid),
    def: M.defOf(state, iid),
    value: M.valueOf(state, iid),
    tribes: ci.tribes,
    tapped: ci.tapped,
    ...(ci.stunned ? { stunned: true } : {}),
    faceDown: ci.faceDown,
    counters: ci.counters,
    ...(ci.token ? { token: true } : {}),
    ...(ci.pos ? { pos: ci.pos } : {}),
    overlays: ci.overlays.length,
    ...(ci.overlays.length ? { overlaid: ci.overlays.map((ov) => visibleCard(state, ov)) } : {}),
  };
}
/** A board card: face-up is public; face-down hides its identity/stats. */
function boardCard(state: GameState, iid: string): CardView {
  const ci = state.instances[iid];
  if (ci?.faceDown) return { iid, cardId: null, faceDown: true, tapped: ci.tapped, ...(ci.pos ? { pos: ci.pos } : {}) };
  const v = visibleCard(state, iid);
  return M.cannotBeAttacked(state, iid) ? { ...v, unattackable: true } : v;
}
/** A hidden card (opponent hand): identity withheld. */
const hiddenCard = (iid: string): CardView => ({ iid, cardId: null });

/** Doxxed (Jane4, MJG-047): a live copy on any living board makes the top of
 *  both decks public. */
function doxxed(state: GameState): boolean {
  return state.players.some(
    (p) =>
      !p.eliminated &&
      p.board.some((b) => {
        const ci = state.instances[b];
        return ci !== undefined && ci.cardId === "MJG-047" && !ci.faceDown && !M.isEffectNegated(state, b);
      }),
  );
}

const LOG_TAIL = 60;

/** The view `seat` is allowed to see of `state`. Never leaks hidden info. */
export function redactFor(state: GameState, seat: Seat): ClientView {
  // collect the targets locked onto effects currently on the chain (public).
  const chainTargets = state.chain.flatMap((l) => l.script?.targets ?? []);
  const targets = chainTargets.filter((t) => state.instances[t]); // card-iid targets
  const targetSeats = [...new Set(chainTargets.filter((t) => !state.instances[t]).map(Number).filter((n) => !Number.isNaN(n)))];
  const b = state.pendingBattle;
  const battle = b && b.attackerId && b.targetId ? { attacker: b.attackerId, target: b.targetId } : null;
  return {
    viewer: seat,
    phase: state.phase,
    activePlayer: state.activePlayer,
    prioritySeat: state.prioritySeat,
    winner: state.winner,
    chainDepth: state.chain.length,
    stack: state.chain.map((l) => ({
      controller: l.script?.controller ?? l.sourcePlayer,
      effectId: l.effectId ?? "",
      card: l.script ? visibleCard(state, l.script.self) : { iid: "", cardId: null },
      targets: l.script?.targets ?? [],
    })),
    pendingEvents: state.events.length,
    seating: state.seating,
    mainDeckCount: state.mainDeck.length, // contents/order never sent
    // the deck tops are public while upside-down (Main only) or Doxxed (both)
    deckTop: (state.deckFlipped || doxxed(state)) && state.mainDeck[0] ? visibleCard(state, state.mainDeck[0]) : null,
    deckFlipped: state.deckFlipped,
    faithTop: doxxed(state) && state.faithDeck[0] ? visibleCard(state, state.faithDeck[0]) : null,
    revealedHands: state.handRevealedTo
      .filter((r) => r.viewer === seat)
      .map((r) => ({
        owner: r.owner,
        cards: (state.players.find((p) => p.pid === r.owner)?.hand ?? []).map((iid) => visibleCard(state, iid)),
      })),
    faithDeckCount: state.faithDeck.length,
    bonds: state.matchmakerBonds.map((m) => ({ a: m.a, b: m.b })),
    discard: state.discard.map((iid) => visibleCard(state, iid)),
    banish: state.banish.map((iid) => visibleCard(state, iid)),
    extraZone: state.extraZone.map((iid) => visibleCard(state, iid)),
    players: state.players.map((p) => ({
      pid: p.pid,
      eliminated: p.eliminated,
      handCount: p.hand.length,
      ...(Object.keys(p.counters).some((k) => p.counters[k]) ? { counters: { ...p.counters } } : {}),
      ...(state.poisonActive.includes(p.pid) ? { poison: "active" as const }
        : state.pendingPoison.includes(p.pid) ? { poison: "armed" as const } : {}),
      boardPages: p.boardPages ?? 1,
      ...(p.pid === seat ? { hand: p.hand.map((iid) => visibleCard(state, iid)) } : {}),
      board: p.board.map((iid) => boardCard(state, iid)),
      meldZone: p.meldZone.map((m) => ({ kind: m.kind, kan: m.kan, cards: m.cards.map((iid) => visibleCard(state, iid)), ...(m.values ? { values: [...m.values] } : {}) })),
    })),
    log: state.log.slice(-LOG_TAIL),
    pending: {
      battle,
      targets,
      targetSeats,
      discards: state.pendingDiscards.map((d) => d.iid),
      meld: state.pendingMeld
        ? {
            player: state.pendingMeld.player,
            cards: state.pendingMeld.materials.map((iid) => visibleCard(state, iid)),
            ...(state.pendingMeld.values ? { values: [...state.pendingMeld.values] } : {}),
          }
        : null,
    },
  };
}

// ---- session ----------------------------------------------------------------
export interface ApplyResult {
  ok: boolean;
  error?: string;
}

export type ChainToggle = "off" | "auto" | "always";
// "off":    never prompted (auto-pass every window).
// "auto":   prompted only at windows where you have a legal response (canRespond).
// "always": prompted at EVERY open window, even with nothing to do (full priority
//           control — you choose to pass each time), like Master Duel's "on".

/** High-level commands a seat issues (the client never touches raw reducer
 *  actions / priority). Targets for `activate` are chosen at activation. */
export type Command =
  | { do: "draw" }
  | { do: "endTurn" }
  | { do: "advance" }
  | { do: "discard"; iid: string }
  | { do: "summon"; iid: string }
  | { do: "attack"; attacker: string; target: string }
  | { do: "meld"; materials: string[]; values?: number[]; source?: string } // 3 material iids; `values` pins ☆ materials; `source` = active driving a hand special-meld (>dama)
  | { do: "kan"; meldIndex: number; material: string } // add a matching 4th card to your non-KAN triplet
  | { do: "activate"; iid: string; role: string; targets?: string[]; as?: string };

export type Response = { pass: true } | { activate: { iid: string; role: string; targets?: string[]; as?: string } };
/** A client's answer to an optional/targeted trigger prompt. */
export type Choice = { use: boolean; target?: string; order?: string[]; value?: number; materials?: string[];
  place?: { seat: Seat; x: number; y: number; page: number } }; // Explosive Aria board-click
/** Free mode (dev sandbox on the auto board): direct zone manipulation of any card the
 *  seat can SEE — no turn structure, no summon/meld limits, no events or triggers. */
export type FreeAction =
  | { do: "summon"; iid: string } // to the acting seat's board, face-up untapped
  | { do: "discard"; iid: string }
  | { do: "banish"; iid: string }
  | { do: "hand"; iid: string } // to the acting seat's hand
  | { do: "deck"; iid: string } // back into its OWN deck (Faith cards -> Faith deck), then shuffle it
  | { do: "meld"; materials: string[] } // 3 visible cards forming a triplet/sequence -> your meld zone
  | { do: "draw"; deck: "main" | "faith" } // top of the chosen deck -> your hand
  | { do: "search"; deck: "main" | "faith" }; // browse the chosen deck (you only) and take 1; shuffles after
/** Free-position board arrangement (real games): drag your own board cards around,
 *  browse/add your own pages. `view` also steers where future auto-placements land
 *  (new cards drop onto the page you are looking at). */
export type BoardAction =
  | { do: "move"; iid: string; x: number; y: number; page: number }
  | { do: "addPage" }
  | { do: "view"; page: number };

/** An open optional-trigger prompt for one seat: use it? and (if any) which target. */
export interface ChoicePrompt {
  effectId: string; // `${cardId}:${role}` — client derives the name
  options: { iid: string; cardId: string | null; zone: string; label?: string }[]; // candidates (empty = yes/no only); `label` overrides the card-name display
  mandatory?: boolean; // true = must pick one (no skip), e.g. a resolution choice
  prompt?: string; // an explicit yes/no question (a resolution "you can …"); shown instead of the effect name
  reorder?: boolean; // true = an ordering choice: client shows a reorder pop-up and submits the full order
  numberInput?: { min: number; max: number }; // a numeric answer (e.g. a VALUE guess 1-9)
  handMeld?: boolean; // pick 3 hand cards for a special meld (Belly Dance copying >dama)
  // pick a card from YOUR OWN hand: the client renders this like the hand-size
  // discard — click a hand card and an action button (this label, e.g. "discard"
  // / "reveal" / "banish") pops up on it. THE standard for every effect that
  // picks/discards from the chooser's own hand — never a generic option list.
  handPick?: string;
  // multi-pick costs (discard 2 / banish 6 / faith totals): the cards already picked
  // this prompt — they stay in place until the cost completes, so the client outlines
  // them to show what's been selected so far.
  picked?: string[];
  // a yes/no answered on a POPUP showing this player's revealed hand (Collusion): the
  // prompt renders as a hand viewer with accept/reject buttons.
  revealOwner?: number;
  ack?: boolean; // acknowledgment-only: the popup shows a single confirm button
  // Explosive Aria: the picked card rides the mouse; the client answers with
  // `place: { seat, x, y, page }` from a click on a board area
  placeCard?: { iid: string; cardId: string | null };
  massPick?: boolean; // mass discard: this seat picks which of their cards falls next
  preview?: { iid: string; cardId: string | null }; // a card to show as a clickable link (Fortune Teller scry)
}

/** What a client receives: the redacted board plus this seat's legal options,
 *  whether the seat is being prompted to respond, and its chain toggle. */
export interface SeatView extends ClientView {
  legal: LegalAction[];
  awaiting: boolean;
  choice: ChoicePrompt | null; // present (for this seat) when an optional trigger needs a decision
  toggle: ChainToggle;
  arrange: boolean; // may this seat drag its board cards around right now?
  cheats?: boolean; // room option (decorated by GameRoom): dev tool + Free mode available
  names?: Record<number, string>; // seat -> nickname (decorated by GameRoom)
}

const WINDOW = (p: M.Phase) => p === M.Phase.ACTION_ANNOUNCED || p === M.Phase.RESPONSE_WINDOW;

/**
 * Authoritative game session + priority orchestration.
 *
 * The session owns priority: it auto-passes seats that can't (or per toggle
 * won't) respond and auto-resolves windows, so clients never press
 * resolve/proceed. Per-seat chain toggle:
 *   - "off":  never prompted (auto-pass).
 *   - "auto": prompted only at response windows where they have a legal
 *             response (canRespond).
 * When a seat must be prompted, `awaiting` names them and `settle` stops.
 */
export class GameSession {
  state: GameState;
  awaiting: Seat | null = null; // seat currently prompted to respond (null = none)
  private toggles = new Map<Seat, ChainToggle>();
  private passed = new Set<Seat>(); // seats that have passed the current window
  private devCounter = 0; // unique-iid source for the dev spawn tool
  // optional-trigger decision flow: a batch is processed one at a time; optional
  // triggers prompt their controller (pendingChoice) before being placed/skipped.
  private pendingChoice: { player: Seat; effectId: string; self: string; candidates: string[] } | null = null;
  private trigQueue: Trigger[] = []; // remaining triggers awaiting decision (SEGOC order)
  private trigReady: Trigger[] = []; // accepted triggers, to place once all decided
  // a decision made AS the top link resolves (PSCT "choose" / "you can"): the link's
  // controller picks, and the pick is written into the link before it resolves.
  // mode "choose" -> script.targets; mode "opt" -> script.opt.
  private pendingResolve: {
    player: Seat;
    effectId: string;
    linkIdx: number;
    mode: "choose" | "opt" | "order" | "number" | "handMeld"; // choose=pick one; order=sequence; opt=yes/no; number=numeric; handMeld=pick 3 hand cards
    handPick?: string; // a "choose" from the chooser's own hand (card-click + this button label)
    append?: boolean; // a "choose" whose pick APPENDS to the link's targets (vs replacing them)
    toTargets?: boolean; // a "number" answer written into the link's targets (vs pendingGuess)
    usualPick?: boolean; // The Usual?: the answer reorders the link's targets to [seat, pick, ...rest]
    options: { value: string; cardId: string | null; zone: string; label?: string }[];
    picked?: string[]; // multi-pick costs: cards already chosen (still in place) — outlined client-side
    optional?: boolean; // a cancellable prompt (Free-mode search): the client may dismiss it (use:false)
    revealOwner?: Seat; // an opt prompt answered on a POPUP of this player's revealed hand (Collusion)
    ack?: boolean; // acknowledgment-only popup: a single confirm button, no reject
    placeCard?: string; // Explosive Aria: the picked hand card awaiting its board-click placement
    previewIid?: string; // a card to reveal as a clickable link in the prompt (Fortune Teller)
    massPick?: boolean; // mass discard: the chooser picks which of their cards falls next
    prompt?: string;
    min?: number;
    max?: number;
  } | null = null;
  // a Watson-style value guess in progress (kept server-side so the random subject
  // isn't leaked to the guesser): the picked card + the activator's guess so far.
  private pendingGuess: { linkIdx: number; controller: Seat; target: Seat; subject: string; guess?: number; starValue?: number } | null = null;
  // the G***u odd/even guessing game in progress on a chain link: the controller
  // picks a hand card, the target guesses its parity, a wrong guess costs the
  // target a discard of their choice; up to 3 rounds (controller decides).
  private pendingParity: {
    linkIdx: number; controller: Seat; target: Seat; round: number;
    stage: "pick" | "guess" | "discard" | "repeat"; subject?: string;
  } | null = null;
  // NEET "Simp" in progress: the target privately picks >=1 of the deck top 3 to
  // give to the controller; picks append to the link's targets as they're made.
  private pendingSimp: { linkIdx: number; target: Seat; remaining: string[]; stage: "pick" | "more" } | null = null;
  // Ravioli "succ" in progress: `pending` is the next character to attach; after
  // each attach the controller may repeat with a fresh pick (the value filter is
  // re-evaluated against the GROWN value each round).
  private pendingSucc: { linkIdx: number; pending: string | null; stage: "repeat" | "pick" } | null = null;
  // TSUOM in progress: the remaining opponents (anticlockwise) yet to pick their discard.
  private pendingTsuom: { linkIdx: number; queue: Seat[] } | null = null;
  // Beautification Council (MJG-C12) in progress: each player (anticlockwise from the
  // controller) discards half their hand — `remaining` is locked at floor(hand/2) when
  // the queue is built, picked one card at a time.
  private pendingHalfDiscard: { linkIdx: number; queue: { seat: Seat; remaining: number }[] } | null = null;
  // an activation in progress whose pre-colon decision (PSCT activation condition) is
  // still being made — the link is NOT chained until it resolves (see advanceActivation).
  private pendingActivation: {
    seat: Seat; iid: string; role: string; eid: string; targets: string[];
    opt?: boolean; subject?: string; guess?: number; starValue?: number;
    cost?: string[]; // hand cards picked so far for a discard cost (Gweilo)
    as?: string; // Twin Personality: the granting cardId (the ability borrowed from an overlay)
  } | null = null;
  // a Belly Dance copy in progress: the chosen character + the copied Active's role
  // and gathered targets, before the link is transformed into that Active.
  // `attachTo` (Strawberry Cup "Class Card"): after the copied Active resolves, the subject
  // card is attached to this iid as an overlay. `needSubject`: the subject is a hand card still
  // to be picked (Class Card reveals it at resolution; Belly Dance sets `char` up front).
  private pendingBelly: { linkIdx: number; controller: Seat; char: string; role?: "top" | "bottom"; targets: string[]; attachTo?: string; needSubject?: boolean } | null = null;
  // MARY "Literary Club": a declared attack paused for its mandatory discard cost. The
  // attack is only issued once the attacker discards a hand card (see choose()).
  private pendingAttack: { seat: Seat; attacker: string; target: string } | null = null;
  // Chocolate Cup "Mana Extraction": an optional in-window choice to attach a battle loser to
  // the Chocolate that discarded it (instead of discarding). `manaOffered` dedups per loser so
  // the prompt isn't repeated; cleared when the battle-discard window empties.
  private manaPending: { loser: string; host: string } | null = null;
  // a declared KAN awaiting its Rinshan Kaihou Faith-deck pick (Cute Boy replaces the
  // bottom-draw with a search): the KAN resolves once the searcher picks a Faith card.
  private pendingKan: { meldIndex: number; material: string } | null = null;
  // controller of the most recently RESOLVED chain link, while its post-resolution
  // window is still open (cleared once play returns to a stable phase). Lets "auto"
  // prompt cards that react to an opponent's effect FINISHING (Shoumakyou).
  private lastResolvedBy: Seat | null = null;
  // a Free-mode deck search awaiting its pick (the deck contents are revealed to the
  // searcher only, via the seat-gated choice prompt). Cancellable (optional prompt).
  private pendingFreeSearch: { seat: Seat; deck: "main" | "faith" } | null = null;
  // a LIVE! placement being answered (multiple candidate hosts): the owner picks the
  // character Spinzaku overlays on top of.
  private pendingLive: { iid: string; controller: Seat } | null = null;
  // Collusion (MJG-M04): linkIdx whose reveal-back ACK popup was already shown to the
  // activator (the draws resolve only once they confirm). Cleared when the chain empties.
  private colludeAcked: number | null = null;
  // "Ya Boy" Fortune Teller (MJG-M20): a pending pre-draw scry (look at the deck top,
  // optionally bottom it) before the turn draw resolves.
  private pendingFortune: { seat: Seat } | null = null;
  // a one-by-one mass discard just landed: open its response window at the next stable
  // point, attributed to the discarding effect's controller (so "auto" seats prompt)
  private massWindow: { by?: Seat } | null = null;
  // Class Card (MJG-C23): the "also, attach it" clause runs AFTER the copied Active
  // resolves — if the revealed card left the hand by then (e.g. it was melded by the
  // copied >dama), the attach FIZZLES silently while the effect still resolved.
  private pendingClassAttach: { host: string; card: string } | null = null;
  private manaOffered = new Set<string>();
  // Cum Chalice "Gate of Babyron" in progress: Special Summon every hand card (chalice first),
  // each attacking a chosen target if possible, then bounce the board (except the chalice) and
  // end the turn. Driven from the settle loop between battles.
  private pendingBabylon: { controller: Seat; chalice: string; stage: "summon" | "attack"; attacker?: string } | null = null;
  // CEOofLuckshitting "Minimum Wage" in progress: at the start of `recipient`'s turn, each
  // off-turn controller of a face-up Minimum Wage gives N cards from their hand to the recipient
  // (N=2 in a 2-player game, else 1), one card at a time.
  private pendingWage: { recipient: Seat; queue: { giver: Seat; remaining: number }[] } | null = null;
  // Blood Sprout "Tuorps" in progress: at the start of the active player's turn (after drawing),
  // they discard 1 card of their choice per off-turn controller of a live Blood Sprout.
  private pendingTuorps: { player: Seat; remaining: number } | null = null;

  constructor(state: GameState) {
    this.state = state;
  }

  /** Open the game's starting-hands window (FAQ: open, anticlockwise from the
   *  first player) once after construction, then settle to the first turn draw. */
  begin(): ApplyResult {
    if (this.state.phase === M.Phase.TURN_START_DRAW && this.state.log.length === 0) {
      this.reduce({ type: M.ActionType.OPEN_WINDOW, returnPhase: M.Phase.TURN_START_DRAW });
    }
    return this.settle();
  }

  toggleOf(seat: Seat): ChainToggle {
    return this.toggles.get(seat) ?? "off";
  }
  setToggle(seat: Seat, t: ChainToggle): void {
    this.toggles.set(seat, t);
  }
  view(seat: Seat): ClientView {
    return redactFor(this.state, seat);
  }
  /** "Geass" (MJG-ZERO): while a turn is controlled, `{ by, tgt }` — else null. */
  private geassCtl(): { by: Seat; tgt: Seat } | null {
    return this.state.turnControlledBy !== null ? { by: this.state.turnControlledBy, tgt: this.state.activePlayer } : null;
  }

  /** May `seat` drag its board cards right now? Own turn, with NOTHING pending —
   *  positions feed positional effects (Noir Attack / Explosive Aria), so
   *  arranging is frozen the moment anything is on the stack or announced. */
  private canArrange(seat: Seat): boolean {
    return this.state.activePlayer === seat && this.state.turnControlledBy === null
      && this.awaiting === null && this.pendingResolve === null && this.pendingChoice === null && this.pendingActivation === null
      && this.state.chain.length === 0 && !this.state.pendingBattle && this.state.pendingDiscards.length === 0
      && this.state.pendingForcedDiscards.length === 0 && !this.state.announcedSummon && !this.state.pendingMeld
      && this.state.phase === M.Phase.MAIN_PHASE;
  }

  /** Free-position board arrangement: drag your own cards, browse/add your pages. */
  board(seat: Seat, a: BoardAction): ApplyResult {
    const pl = this.state.players.find((p) => p.pid === seat);
    if (!pl || pl.eliminated) return { ok: false, error: "no such seat" };
    if (a.do === "view") {
      const page = Math.max(0, Math.min(Math.floor(a.page) || 0, pl.boardPages - 1));
      this.state = M.replace(this.state, { boardView: { ...this.state.boardView, [seat]: page } });
      return { ok: true };
    }
    if (a.do === "addPage") {
      if (pl.boardPages >= M.BOARD_GEOM.pageCap) return { ok: false, error: "page limit reached" };
      // a new page is only warranted once every existing page holds at least 4 cards
      for (let pg = 0; pg < pl.boardPages; pg++) {
        const n = pl.board.filter((b) => (this.state.instances[b]?.pos?.page ?? 0) === pg).length;
        if (n < 4) return { ok: false, error: "every page needs at least 4 cards before adding another" };
      }
      this.state = M.replace(this.state, { players: this.state.players.map((p) => (p.pid === seat ? { ...p, boardPages: p.boardPages + 1 } : p)) });
      return { ok: true };
    }
    // move: your own board card, on your turn, with nothing pending
    if (!pl.board.includes(a.iid)) return { ok: false, error: "not on your board" };
    if (!this.canArrange(seat)) return { ok: false, error: "the board can only be arranged during your turn with nothing pending" };
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.page)) return { ok: false, error: "bad position" };
    const page = Math.floor(a.page);
    if (page < 0 || page >= pl.boardPages) return { ok: false, error: "no such page" };
    const x = Math.max(0, Math.min(Math.round(a.x), M.BOARD_GEOM.maxX));
    const y = Math.max(0, Math.min(Math.round(a.y), M.BOARD_GEOM.maxY));
    this.state = M.replace(this.state, { instances: { ...this.state.instances, [a.iid]: { ...this.state.instances[a.iid]!, pos: { x, y, page } } } });
    return { ok: true };
  }

  /** Full per-seat view: board + legal options + response state + toggle. */
  viewFor(seat: Seat): SeatView {
    // Geass: the CONTROLLER's perspective fully becomes the target's for the turn —
    // their hand, board-as-self, legal actions and prompts. The TARGET just watches:
    // normal view of their own board, but no actions/prompts (their inputs are blocked).
    const ctl = this.geassCtl();
    if (ctl && seat === ctl.by) seat = ctl.tgt;
    else if (ctl && seat === ctl.tgt) {
      return { ...redactFor(this.state, seat), legal: [], awaiting: false, choice: null, toggle: this.toggleOf(seat), arrange: false };
    }
    const pc = this.pendingChoice;
    return {
      ...redactFor(this.state, seat),
      legal: legalActions(this.state, seat),
      awaiting: this.awaiting === seat,
      choice: this.pendingResolve && this.pendingResolve.player === seat
        ? (this.pendingResolve.mode === "opt"
            ? { effectId: this.pendingResolve.effectId, options: [], prompt: this.pendingResolve.prompt, ...(this.pendingResolve.revealOwner !== undefined ? { revealOwner: this.pendingResolve.revealOwner } : {}), ...(this.pendingResolve.ack ? { ack: true } : {}), ...(this.pendingResolve.previewIid ? { preview: { iid: this.pendingResolve.previewIid, cardId: this.state.instances[this.pendingResolve.previewIid]?.cardId ?? null } } : {}) }
            : this.pendingResolve.mode === "number"
            ? { effectId: this.pendingResolve.effectId, options: [], prompt: this.pendingResolve.prompt, numberInput: { min: this.pendingResolve.min ?? 1, max: this.pendingResolve.max ?? 9 } }
            : this.pendingResolve.mode === "handMeld"
            ? { effectId: this.pendingResolve.effectId, options: [], prompt: this.pendingResolve.prompt, handMeld: true }
            : { effectId: this.pendingResolve.effectId, mandatory: !this.pendingResolve.optional, prompt: this.pendingResolve.prompt,
                ...(this.pendingResolve.mode === "order" ? { reorder: true } : {}),
                ...(this.pendingResolve.handPick ? { handPick: this.pendingResolve.handPick } : {}),
                ...(this.pendingResolve.placeCard ? { placeCard: { iid: this.pendingResolve.placeCard, cardId: this.state.instances[this.pendingResolve.placeCard]?.cardId ?? null } } : {}),
                ...(this.pendingResolve.massPick ? { massPick: true } : {}),
                ...(this.pendingResolve.picked?.length ? { picked: [...this.pendingResolve.picked] } : {}),
                options: this.pendingResolve.options.map((o) => ({ iid: o.value, cardId: o.cardId, zone: o.zone, label: o.label })) })
        : pc && pc.player === seat
        ? { effectId: pc.effectId, options: pc.candidates.map((iid) => ({ iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: this.zoneOf(iid) })) }
        : null,
      toggle: this.toggleOf(seat),
      arrange: this.canArrange(seat),
    };
  }

  /** Where an instance currently is (for labelling choice candidates). */
  private zoneOf(iid: string): string {
    if (this.state.mainDeck.includes(iid)) return "deck";
    if (this.state.discard.includes(iid)) return "discard";
    for (const p of this.state.players) {
      if (p.hand.includes(iid)) return "hand";
      if (p.board.includes(iid)) return "board";
    }
    return "?";
  }

  /** Low-level escape hatch (tests / scripted flows). Prefer command/respond. */
  apply(seat: Seat, action: Action): ApplyResult {
    if (action.player !== undefined) {
      if (action.player !== seat) return { ok: false, error: `seat ${seat} cannot act as player ${action.player}` };
    } else if (seat !== this.state.activePlayer) {
      return { ok: false, error: `seat ${seat} is not the active player` };
    }
    try {
      this.state = M.reduce(this.state, action);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ---- high-level command flow ---------------------------------------------
  command(seat: Seat, cmd: Command): ApplyResult {
    if (this.awaiting !== null || this.pendingChoice !== null || this.pendingResolve !== null || this.pendingActivation !== null) return { ok: false, error: "a response is pending" };
    // "Geass" (MJG-ZERO): while this turn is controlled, only the controller may act, and
    // they do so AS the active player (using the active player's hand and board).
    if (this.state.turnControlledBy !== null) {
      if (seat !== this.state.turnControlledBy) return { ok: false, error: `seat ${seat}'s turn is controlled by player ${this.state.turnControlledBy} (Geass)` };
      seat = this.state.activePlayer;
    }
    // a forced board-discard (FAQ §9) lets the affected owner act even off-turn
    const forcedDiscarder = this.state.phase === M.Phase.FORCED_DISCARD ? this.state.pendingForcedDiscards[0]?.player : undefined;
    if (seat !== this.state.activePlayer && seat !== forcedDiscarder) return { ok: false, error: `seat ${seat} is not the active player` };
    this.passed.clear();
    try {
      switch (cmd.do) {
        case "draw":
          // "Ya Boy" Fortune Teller: look at the deck top (optionally bottom it) BEFORE
          // the turn draw. If prompted, the draw resumes when the scry is answered.
          if (this.maybePromptFortune(seat)) return { ok: true };
          this.doTurnDraw();
          break;
        case "endTurn":
          this.requireLegal(seat, (a) => a.kind === "endTurn", "end turn");
          // end-of-turn is an open window: batched end-of-turn triggers, then
          // hand-size discard / turn end (closeWindow -> enterDiscardOrEnd)
          this.reduce({
            type: M.ActionType.OPEN_WINDOW,
            triggers: collectEndOfTurnTriggers(this.state, this.state.activePlayer),
            returnPhase: M.Phase.DISCARD_DOWN,
          });
          break;
        case "advance": this.reduce({ type: M.ActionType.ADVANCE }); break;
        case "kan": {
          this.requireLegal(seat, (a) => a.kind === "kan" && a.meldIndex === cmd.meldIndex && a.materialIds.includes(cmd.material), "KAN");
          // Rinshan Kaihou (Cute Boy): the bottom-draw is replaced by a Faith-deck search —
          // prompt the pick first (shown to the searcher only), then resolve the KAN with it.
          if (M.controlsRinshan(this.state, seat) && this.state.faithDeck.length > 0) {
            this.pendingKan = { meldIndex: cmd.meldIndex, material: cmd.material };
            this.pendingResolve = { player: seat, effectId: "MJG-C01:top", linkIdx: -1, mode: "choose",
              options: this.state.faithDeck.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "deck" })),
              prompt: "Rinshan Kaihou — search the Faith Deck for any 1 card (instead of the bottom draw)" };
            return { ok: true };
          }
          this.reduce({ type: M.ActionType.RESOLVE_KAN, player: seat, meldIndex: cmd.meldIndex, kanMaterial: cmd.material });
          break;
        }
        case "discard":
          this.requireLegal(seat, (a) => a.kind === "discard" && a.iid === cmd.iid, "discard");
          this.reduce({ type: M.ActionType.DISCARD, discardId: cmd.iid });
          break;
        case "summon":
          this.requireLegal(seat, (a) => a.kind === "normalSummon" && a.iid === cmd.iid, "summon");
          this.reduce({ type: M.ActionType.NORMAL_SUMMON, player: seat, summonId: cmd.iid });
          break;
        case "attack":
          if (this.declareAttack(seat, cmd.attacker, cmd.target)) return { ok: true }; // paused for the Literary Club discard cost
          break;
        case "meld":
          if (cmd.source !== undefined) {
            // special meld from hand via an on-board active (>dama): taps the source
            const src = cmd.source;
            const act = legalActions(this.state, seat).find(
              (a): a is Extract<LegalAction, { kind: "activate" }> => a.kind === "activate" && a.iid === src && a.handMeld === true,
            );
            if (!act) throw new Error("illegal hand meld");
            const eid = `${this.state.instances[src]?.cardId ?? ""}:${act.role}`;
            // "Reveal N cards from your hand" (MJG-002 bottom): log them before they meld
            this.state = M.replace(this.state, { log: [...this.state.log, `player ${seat} reveals ${cmd.materials.map((iid) => this.state.instances[iid]?.cardId ?? iid).join(", ")}`] });
            this.reduce({ type: M.ActionType.DECLARE_MELD, player: seat, materials: cmd.materials, values: cmd.values, special: true, fromHand: true, tapSource: src, effectId: eid });
          } else {
            this.requireLegal(seat, (a) => a.kind === "meld", "meld");
            this.reduce({ type: M.ActionType.DECLARE_MELD, player: seat, materials: cmd.materials, values: cmd.values });
          }
          break;
        case "activate": {
          const tg = this.validateActivation(seat, cmd.iid, cmd.role, cmd.targets, cmd.as);
          // Catbox (Extra Zone): mark this player's once-per-turn use of the uploaded Active.
          if (this.state.extraZone.includes(cmd.iid)) {
            const k = `EXTRA ${cmd.iid}:${cmd.role} ${seat}`;
            this.state = M.replace(this.state, { usage: { ...this.state.usage, once_per_turn: { ...(this.state.usage["once_per_turn"] ?? {}), [k]: 1 } } });
          }
          // `as` (Twin Personality): the ability key is the GRANTING cardId, not the instance's.
          const eid = `${cmd.as ?? this.state.instances[cmd.iid]?.cardId ?? ""}:${cmd.role}`;
          if (ACTIVATION_CHOICES[eid]) {
            // pre-colon decision (guess / redeem) resolves BEFORE the link is chained.
            this.pendingActivation = { seat, iid: cmd.iid, role: cmd.role, eid, targets: tg, as: cmd.as };
            if (this.advanceActivation()) return { ok: true }; // paused for the decision
          } else {
            this.announceActivation(seat, cmd.iid, cmd.role, tg.length ? tg : undefined, undefined, cmd.as);
          }
          break;
        }
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return this.settle();
  }

  /** The awaited seat responds (activate an (At any time) effect) or passes. */
  respond(seat: Seat, r: Response): ApplyResult {
    // Geass: the controller answers the TARGET's windows as them; the target's own
    // inputs are blocked for the controlled turn.
    const ctl = this.geassCtl();
    if (ctl && seat === ctl.tgt) return { ok: false, error: `your turn is controlled by player ${ctl.by} (Geass)` };
    if (ctl && seat === ctl.by && this.awaiting === ctl.tgt) seat = ctl.tgt;
    if (this.awaiting !== seat) return { ok: false, error: "no response expected from this seat" };
    try {
      if ("activate" in r) {
        const { iid, role, targets, as } = r.activate;
        // validate BEFORE clearing `awaiting` so bad input can be retried (and a
        // malformed response can't crash the room during resolution).
        const tg = this.validateActivation(seat, iid, role, targets, as);
        this.awaiting = null;
        // `as` (Twin Personality): the script runs the GRANTING card's ability (self = iid).
        const cardId = as ?? this.state.instances[iid]?.cardId ?? "";
        const eid = `${cardId}:${role}`;
        const script = { cardId, role, self: iid, ...(tg.length ? { targets: tg } : {}) };
        // OPT per card name: a granted response keys its usage under the host card
        const usageId = as !== undefined ? `${this.state.instances[iid]?.cardId ?? iid}>${eid}` : undefined;
        if (this.state.phase === M.Phase.ACTION_ANNOUNCED) {
          this.reduce({ type: M.ActionType.OPEN_RESPONSE, player: seat, effectId: eid, script });
        } else {
          // the session owns priority -> align the reducer's priority seat
          this.state = M.replace(this.state, { prioritySeat: seat });
          this.reduce({ type: M.ActionType.ADD_TO_CHAIN, player: seat, effectId: eid, script, ...(usageId ? { usageId } : {}) });
        }
        this.passed.clear(); // chain grew: everyone may respond again
      } else {
        this.awaiting = null;
        this.passed.add(seat);
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return this.settle();
  }

  // ---- internals ------------------------------------------------------------
  private reduce(action: Action): void {
    this.state = M.reduce(this.state, action);
  }

  /** DEV/testing tool: materialise any card into `seat`'s hand (any phase). */
  devSpawn(seat: Seat, cardId: string): ApplyResult {
    try {
      this.reduce({ type: M.ActionType.DEV_SPAWN, player: seat, spawnCardId: cardId, spawnIid: `dev-${this.devCounter++}` });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return this.settle();
  }

  /** Free mode: can `seat` SEE this card? Public zones (any board face-up card + its
   *  overlays, discard, banish, Extra Zone), plus the seat's own hand and face-down
   *  board cards. Deck and meld-zone cards are out of reach. */
  private freeVisible(seat: Seat, iid: string): boolean {
    const s = this.state;
    if (s.discard.includes(iid) || s.banish.includes(iid) || s.extraZone.includes(iid)) return true;
    for (const p of s.players) {
      if (p.hand.includes(iid)) return p.pid === seat; // only your own hand
      if (p.board.includes(iid)) return p.pid === seat || !s.instances[iid]?.faceDown;
      for (const b of p.board) if (s.instances[b]?.overlays.includes(iid)) return true; // materials are public
    }
    return false;
  }
  /** Free mode: pull a card out of whatever zone/overlay holds it and shed its in-play
   *  state. `keepOverlays` (a free summon) lets its own materials ride along; otherwise
   *  they go to the discard (a card leaving the board sheds its materials). */
  private freeDetach(iid: string, keepOverlays: boolean): void {
    const s = this.state;
    let instances = { ...s.instances };
    for (const [hid, hc] of Object.entries(instances)) {
      if (hc.overlays.includes(iid)) instances[hid] = { ...hc, overlays: hc.overlays.filter((x) => x !== iid) };
    }
    const ci = instances[iid]!;
    let discard = s.discard.filter((x) => x !== iid);
    let overlays = ci.overlays;
    if (!keepOverlays && overlays.length > 0) {
      discard = [...overlays, ...discard]; // its materials leave play with it
      overlays = [];
    }
    instances[iid] = { ...ci, overlays, mods: [], counters: {}, battles: 0, tapped: false, faceDown: false, stunned: false, ssThisTurn: false, effectsNegated: false, linkedTo: undefined, protectedFromEffects: false };
    this.state = M.replace(s, {
      instances,
      discard,
      mainDeck: s.mainDeck.filter((x) => x !== iid),
      faithDeck: s.faithDeck.filter((x) => x !== iid),
      banish: s.banish.filter((x) => x !== iid),
      extraZone: s.extraZone.filter((x) => x !== iid),
      players: s.players.map((p) => ({ ...p, hand: p.hand.filter((x) => x !== iid), board: p.board.filter((x) => x !== iid) })),
    });
  }

  /** Free mode: direct sandbox manipulation on the auto board (see FreeAction). Refused
   *  while anything is pending — mutating zones mid-chain would corrupt resolution. */
  free(seat: Seat, a: FreeAction): ApplyResult {
    if (this.awaiting !== null || this.pendingChoice !== null || this.pendingResolve !== null || this.pendingActivation !== null)
      return { ok: false, error: "a response is pending" };
    if (this.state.chain.length > 0) return { ok: false, error: "free mode can't be used during a chain" };
    if (this.state.winner !== null) return { ok: false, error: "the game is over" };
    // deck ops take no card argument — handle them before the visibility checks
    if (a.do === "draw") {
      const pile = a.deck === "faith" ? this.state.faithDeck : this.state.mainDeck;
      if (pile.length === 0) return { ok: false, error: `the ${a.deck} deck is empty` };
      const top = pile[0]!;
      this.state = M.replace(this.state, {
        ...(a.deck === "faith" ? { faithDeck: this.state.faithDeck.slice(1) } : { mainDeck: this.state.mainDeck.slice(1) }),
        players: this.state.players.map((p) => (p.pid === seat ? { ...p, hand: [...p.hand, top] } : p)),
        log: [...this.state.log, `[free] player ${seat} draws from the ${a.deck} deck`],
      });
      return { ok: true };
    }
    if (a.do === "search") {
      const pile = a.deck === "faith" ? this.state.faithDeck : this.state.mainDeck;
      if (pile.length === 0) return { ok: false, error: `the ${a.deck} deck is empty` };
      this.pendingFreeSearch = { seat, deck: a.deck };
      this.pendingResolve = { player: seat, effectId: "free:search", linkIdx: -1, mode: "choose", optional: true,
        options: pile.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "deck" })),
        prompt: `Free search — take a card from the ${a.deck} deck to your hand (it will be shuffled)` };
      return { ok: true };
    }
    const iids = a.do === "meld" ? a.materials : [a.iid];
    for (const iid of iids) {
      if (!this.state.instances[iid]) return { ok: false, error: `no such card ${iid}` };
      if (!this.freeVisible(seat, iid)) return { ok: false, error: "you can't see that card" };
    }
    const name = (iid: string) => this.state.instances[iid]?.cardId || iid;
    const log = (m: string) => (this.state = M.replace(this.state, { log: [...this.state.log, `[free] ${m}`] }));
    switch (a.do) {
      case "summon": {
        this.freeDetach(a.iid, true);
        this.state = M.replace(this.state, { players: this.state.players.map((p) => (p.pid === seat ? { ...p, board: [...p.board, a.iid] } : p)) });
        this.state = M.assignBoardPos(this.state, seat, a.iid);
        log(`player ${seat} summons ${name(a.iid)}`);
        return { ok: true };
      }
      case "discard": {
        this.freeDetach(a.iid, false);
        this.state = M.replace(this.state, { discard: [a.iid, ...this.state.discard] });
        log(`player ${seat} discards ${name(a.iid)}`);
        return { ok: true };
      }
      case "banish": {
        this.freeDetach(a.iid, false);
        this.state = M.replace(this.state, { banish: [a.iid, ...this.state.banish] });
        log(`player ${seat} banishes ${name(a.iid)}`);
        return { ok: true };
      }
      case "hand": {
        this.freeDetach(a.iid, false);
        this.state = M.replace(this.state, { players: this.state.players.map((p) => (p.pid === seat ? { ...p, hand: [...p.hand, a.iid] } : p)) });
        log(`player ${seat} takes ${name(a.iid)} to hand`);
        return { ok: true };
      }
      case "deck": {
        const cardId = this.state.instances[a.iid]?.cardId ?? "";
        this.freeDetach(a.iid, false);
        if (FAITH_DECK.has(cardId)) {
          const sh = shuffleWith(this.state.rngState, [...this.state.faithDeck, a.iid]);
          this.state = M.replace(this.state, { faithDeck: sh.value, rngState: sh.state });
        } else {
          const sh = shuffleWith(this.state.rngState, [...this.state.mainDeck, a.iid]);
          this.state = M.replace(this.state, { mainDeck: sh.value, rngState: sh.state });
        }
        log(`player ${seat} shuffles ${name(a.iid)} into the ${FAITH_DECK.has(cardId) ? "Faith" : "Main"} deck`);
        return { ok: true };
      }
      case "meld": {
        const mats = [...new Set(a.materials)];
        if (mats.length !== 3) return { ok: false, error: "a meld needs 3 distinct cards" };
        const kind = M.meldKind(mats.map((iid) => M.valueOf(this.state, iid)));
        if (kind === null) return { ok: false, error: "those 3 do not form a triplet or sequence" };
        for (const iid of mats) this.freeDetach(iid, false);
        this.state = M.replace(this.state, {
          players: this.state.players.map((p) => (p.pid === seat ? { ...p, meldZone: [...p.meldZone, { cards: mats, kind, kan: false }] } : p)),
        });
        log(`player ${seat} melds ${mats.map(name).join(" + ")} (${kind})`);
        return { ok: true };
      }
    }
  }

  /** Reject a command that isn't among the seat's currently-legal actions. */
  private requireLegal(seat: Seat, pred: (a: LegalAction) => boolean, what: string): void {
    if (!legalActions(this.state, seat).some(pred)) throw new Error(`illegal ${what}`);
  }

  /** Validate an activation (legal here, correct target count & kind) for either a
   *  command or a response. Returns the targets to use, or throws — so malformed
   *  input is rejected up front instead of crashing during resolution. */
  private validateActivation(seat: Seat, iid: string, role: string, targets?: string[], as?: string): string[] {
    const la = legalActions(this.state, seat).find(
      (a): a is Extract<LegalAction, { kind: "activate" }> => a.kind === "activate" && a.iid === iid && a.role === role && a.as === as,
    );
    if (!la) throw new Error("illegal activate");
    const tg = targets ?? [];
    if (tg.length !== la.targets) throw new Error(`effect needs ${la.targets} target(s)`);
    if (la.targetKind === "character") {
      // validate against the server-computed candidate set (honours targetFilter)
      for (const t of tg) if (!la.targetIds?.includes(t)) throw new Error(`${t} is not a valid character target`);
    } else if (la.targetKind === "discard") {
      for (const t of tg) if (!this.state.discard.includes(t)) throw new Error(`${t} is not in the discard pile`);
    } else if (la.targetKind === "opponent" || la.targetKind === "player") {
      for (const t of tg) {
        const pid = Number(t);
        // validate against the server-computed seat set (honours the seat filter)
        const ok = la.targetSeats ? la.targetSeats.includes(pid) : pid !== seat && this.state.players.some((p) => p.pid === pid && !p.eliminated);
        if (!ok) throw new Error(`${t} is not a valid ${la.targetKind}`);
      }
    }
    // cross-target constraint (e.g. Tile Efficiency: the 3 must form a meld on one board)
    const combo = ACTIVATIONS[`${as ?? this.state.instances[iid]?.cardId ?? ""}:${role}`]?.targetCombo;
    if (combo && !combo(this.state, tg, seat)) throw new Error("those targets are not a valid combination");
    return tg;
  }

  /** Validate then declare an attack (opens the declaration window). */
  /** Declare an attack. Returns true if it PAUSED for MARY "Literary Club"'s mandatory
   *  discard cost (the attack is issued later, in choose()); false if it went through. */
  private declareAttack(seat: Seat, attacker: string, target: string): boolean {
    const okAttacker = legalActions(this.state, seat).some((a) => a.kind === "attack" && a.iid === attacker);
    if (!okAttacker) throw new Error(`${attacker} cannot attack now`);
    const okTarget = this.state.players.some(
      (p) => p.pid !== seat && !p.eliminated && p.board.includes(target) && !this.state.instances[target]?.faceDown,
    ) && !M.cannotBeAttacked(this.state, target); // PROTECT Newbaggies / Cupid Doesn't Exist
    if (!okTarget) throw new Error(`${target} is not a legal attack target`);
    if (this.literaryClubCost(seat)) {
      // legality (checkRestrictions) already guarantees a payable non-Brick hand here.
      const hand = choosableHand(this.state, this.state.players.find((p) => p.pid === seat)?.hand ?? []);
      this.pendingAttack = { seat, attacker, target };
      this.pendingResolve = {
        player: seat, effectId: "MJG-C10:top", linkIdx: -1, mode: "choose", handPick: "discard",
        options: hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
        prompt: "Literary Club — discard 1 card to attack",
      };
      return true;
    }
    this.reduce({ type: M.ActionType.DECLARE_BATTLE, attackerId: attacker, targetId: target });
    return false;
  }

  /** MARY "Literary Club" is in play (a face-up MJG-C10 on any board) and `seat` controls
   *  no [Schizo] — so this attacker must pay the discard cost. Mirrors the MJG-C10:top
   *  restriction's notion of "in play"/"control a [Schizo]". */
  private literaryClubCost(seat: Seat): boolean {
    const inPlay = this.state.players.some((p) =>
      p.board.some((iid) => this.state.instances[iid]?.cardId === "MJG-C10" && !this.state.instances[iid]?.faceDown),
    );
    if (!inPlay) return false;
    const me = this.state.players.find((p) => p.pid === seat);
    const hasSchizo = !!me?.board.some((iid) => {
      const ci = this.state.instances[iid];
      // [Schizo] includes characters "considered" Schizo by Heaven's Gate (no [Type] tag).
      return ci !== undefined && !ci.faceDown && M.tribesOf(this.state, iid).includes("Schizo");
    });
    return !hasSchizo;
  }

  /** "activate E": announce, then put the activator's own effect on the chain.
   *  Using an on-board ACTIVE taps the source card (spells from hand don't). */
  private announceActivation(seat: Seat, iid: string, role: string, targets?: string[], opt?: boolean, as?: string): void {
    // `as` (Twin Personality): announce the GRANTING card's ability; self stays `iid`.
    const cardId = as ?? this.state.instances[iid]?.cardId ?? "";
    const eid = `${cardId}:${role}`;
    const script = { cardId, role, self: iid, ...(targets ? { targets } : {}), ...(opt !== undefined ? { opt } : {}) };
    const tap = ACTIVATIONS[eid]?.from === "board" && !this.state.extraZone.includes(iid); // Extra-Zone uses don't tap (shared)
    // OPT is per CARD NAME: a granted (Twin Personality) ability is the HOST's use, so its
    // once-per-X ledger key is namespaced under the host card, not the granting card.
    const usageId = as !== undefined ? `${this.state.instances[iid]?.cardId ?? iid}>${eid}` : undefined;
    this.reduce({ type: M.ActionType.PLAYER_ACTS, player: seat, effectId: eid, ...(tap ? { tapSource: iid } : {}), ...(usageId ? { usageId } : {}) });
    this.reduce({ type: M.ActionType.OPEN_RESPONSE, player: seat, effectId: eid, script });
    // "Snake Bite": a poisoned player activating a SPELL or FAITH card is "playing" it —
    // 1 random hand discard per counter (the played card itself excluded). Self-SS at
    // resolution won't double-charge (see effects.ts poisonSS source dedupe).
    const cat = ACTIVATIONS[eid]?.category;
    if ((cat === "S" || cat === "F") && this.state.poisonActive.includes(seat)) {
      this.state = M.chargePoison(this.state, seat, new Set([iid]));
    }
    // Mooncakes: WHO has activated Emote Spam is public per-game state (a "Mooncake"
    // player counter) — Soulless punishes everyone without one. Recorded at
    // ACTIVATION: a negated Emote Spam still counts as "activated".
    if (eid === "MOON-001:top") {
      this.state = applyIntent(this.state, { kind: "playerCounter", player: seat, counter: "Mooncake", amount: 1 }).state;
    }
  }

  /** Drive a pending activation's pre-colon decision(s). Returns true if it set a
   *  prompt and paused; false once the decision is made and the link is announced.
   *  Mirrors maybePromptResolveChoice's guess/opt logic but BEFORE chaining, so the
   *  outcome is baked into the announced link's targets/opt (PSCT activation condition). */
  private advanceActivation(): boolean {
    const pa = this.pendingActivation;
    if (!pa) return false;
    const spec = ACTIVATION_CHOICES[pa.eid];
    // Watson: pick a random card from the targeted opponent's hand (hidden), guess its
    // VALUE; a ☆ card's owner then sets its value. Correct -> the card becomes the
    // post-colon effect's target (banished); wrong -> no target (the effect no-ops).
    if (spec?.guess) {
      const target = Number(pa.targets[0] ?? "-1");
      if (pa.subject === undefined) {
        const tp = this.state.players.find((p) => p.pid === target && !p.eliminated);
        const hand = tp?.hand ?? [];
        if (!tp || hand.length === 0) {
          this.state = M.replace(this.state, { log: [...this.state.log, `player ${pa.seat}'s Watson: player ${target} has no cards`] });
          this.finishActivation([]);
          return false;
        }
        const r = nextInt(this.state.rngState, hand.length);
        this.state = M.replace(this.state, { rngState: r.state });
        pa.subject = hand[r.value]!;
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "number", options: [], min: 1, max: 9, prompt: `Guess the VALUE (1-9) of a random card in player ${target}'s hand` };
        return true;
      }
      if (pa.guess === undefined) return true; // waiting on the guess
      const v = M.valueOf(this.state, pa.subject);
      if (v === null && pa.starValue === undefined) {
        this.pendingResolve = { player: target, effectId: pa.eid, linkIdx: -1, mode: "number", options: [], min: 1, max: 9, prompt: `Player ${pa.seat} guessed VALUE ${pa.guess} for your ☆ card — set its value (1-9): match to be banished, differ to survive` };
        return true;
      }
      const actual = v === null ? pa.starValue! : v;
      const correct = pa.guess === actual;
      const cardId = this.state.instances[pa.subject]?.cardId || pa.subject;
      const guessLine = `player ${pa.seat} guessed VALUE ${pa.guess} for player ${target}'s ${cardId} (value ${actual}) — ${correct ? "correct: banished + draw 1" : "wrong"}`;
      this.finishActivation(correct ? [pa.subject] : []);
      this.state = M.replace(this.state, { log: [...this.state.log, guessLine] });
      return false;
    }
    // Bravo-style pre-colon reveal: excavate the deck top at activation (public, no
    // decision); the qualifying cards become the link's targets.
    if (spec?.excavate) {
      const ex = this.runExcavate(pa.seat, spec.excavate);
      this.finishActivation(ex.hits);
      this.state = M.replace(this.state, { log: [...this.state.log, ex.line] }); // reveal AFTER the announce
      return false;
    }
    // The Usual?-style pre-colon reveal: the top N of the deck, publicly logged;
    // the revealed cards append to the link's targets after the activation targets.
    if (spec?.revealTop) {
      const top = this.state.mainDeck.slice(0, spec.revealTop);
      const names = top.map((iid) => this.state.instances[iid]?.cardId || iid);
      const revealLine = `player ${pa.seat} reveals the top ${top.length} of the deck: ${names.join(", ")}`;
      this.finishActivation([...pa.targets, ...top]);
      this.state = M.replace(this.state, { log: [...this.state.log, revealLine] });
      return false;
    }
    // Collusion's pre-colon COST: discard this card and show your hand to the
    // targeted opponent (the reveal lasts until the turn change).
    if (spec?.collude) {
      this.state = applyIntent(this.state, { kind: "discard", iid: pa.iid }).state;
      this.state = applyIntent(this.state, { kind: "revealHandTo", owner: pa.seat, viewer: Number(pa.targets[0]) as Seat }).state;
      this.finishActivation(pa.targets);
      return false;
    }
    // Gweilo-style pre-colon COST: discard this card and N OTHER hand cards (picked
    // one at a time via the hand-click UI), then chain the effect.
    if (spec?.discardCost) {
      const need = spec.discardCost;
      pa.cost ??= [];
      if (pa.cost.length < need) {
        const hand = (this.state.players.find((p) => p.pid === pa.seat)?.hand ?? [])
          .filter((iid) => iid !== pa.iid && !pa.cost!.includes(iid) && !M.isBrick(this.state.instances[iid]?.cardId));
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "discard", picked: [...pa.cost],
          options: hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: `Cost — discard ${need - pa.cost.length} more card(s) from your hand` };
        return true;
      }
      // cost complete: discard this card + the picked cards (events fire normally)
      this.state = applyIntent(this.state, { kind: "discard", iid: pa.iid }).state;
      for (const iid of pa.cost) this.state = applyIntent(this.state, { kind: "discard", iid }).state;
      this.finishActivation(pa.targets);
      return false;
    }
    // Faith-summon COST (Anon's Mom "Art"): discard cards from hand/board whose DEF totals
    // EXACTLY spec.faithCost. Pick one card at a time; only cards that keep a valid total
    // reachable are offered. When the total is hit, discard them all and chain the SS.
    if (spec?.faithCost !== undefined) {
      // number = DEF total only (Art); object = exact ATK and/or DEF totals (Knot).
      const need = typeof spec.faithCost === "number" ? { def: spec.faithCost } : spec.faithCost;
      pa.cost ??= [];
      const sumA = pa.cost.reduce((s, iid) => s + M.faithCostStat(this.state, iid, "atk"), 0);
      const sumD = pa.cost.reduce((s, iid) => s + M.faithCostStat(this.state, iid, "def"), 0);
      const remA = need.atk === undefined ? undefined : need.atk - sumA;
      const remD = need.def === undefined ? undefined : need.def - sumD;
      if ((remA === undefined || remA === 0) && (remD === undefined || remD === 0)) {
        for (const iid of pa.cost) this.state = applyIntent(this.state, { kind: "discard", iid }).state;
        this.finishActivation(pa.targets);
        return false;
      }
      const me = this.state.players.find((p) => p.pid === pa.seat);
      // Knot's cost may come from ANY board (opponents' face-up cards included)
      const anyBoard = typeof spec.faithCost === "object" && !!spec.faithCost.anyBoard;
      const avail = [
        ...(me?.hand ?? []), ...(me?.board ?? []),
        ...(anyBoard ? this.state.players.filter((p) => p.pid !== pa.seat && !p.eliminated).flatMap((p) => p.board.filter((x) => !this.state.instances[x]?.faceDown)) : []),
      ].filter((iid) => iid !== pa.iid && !pa.cost!.includes(iid));
      const options = avail.filter((iid) => {
        const a = M.faithCostStat(this.state, iid, "atk"), d = M.faithCostStat(this.state, iid, "def");
        if (remA !== undefined && a > remA) return false;
        if (remD !== undefined && d > remD) return false;
        const rest = avail.filter((x) => x !== iid).map((x) => ({ atk: M.faithCostStat(this.state, x, "atk"), def: M.faithCostStat(this.state, x, "def") }));
        return M.canSumToDims(rest, remA === undefined ? undefined : remA - a, remD === undefined ? undefined : remD - d);
      });
      const parts = [need.atk !== undefined ? `${remA} ATK` : "", need.def !== undefined ? `${remD} DEF` : ""].filter(Boolean);
      this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "select", picked: [...pa.cost],
        options: options.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: (me?.hand ?? []).includes(iid) ? "hand" : "board",
          label: `${this.state.instances[iid]?.cardId || iid} (ATK ${M.faithCostStat(this.state, iid, "atk")} / DEF ${M.faithCostStat(this.state, iid, "def")})` })),
        prompt: `Faith summon — discard cards totaling exactly ${[need.atk !== undefined ? `${need.atk} ATK` : "", need.def !== undefined ? `${need.def} DEF` : ""].filter(Boolean).join(" and ")} (${parts.join(", ")} more needed)` };
      return true;
    }
    // Faith-summon COST: discard ONE card from hand/board whose ATK/DEF/VALUE matches one
    // of the given stats, then chain the SS.
    if (spec?.faithTribute) {
      const f = spec.faithTribute;
      pa.cost ??= [];
      if (pa.cost.length === 0) {
        const me = this.state.players.find((p) => p.pid === pa.seat);
        const matches = (iid: string) =>
          (f.atk !== undefined && M.faithCostStat(this.state, iid, "atk") === f.atk) ||
          (f.def !== undefined && M.faithCostStat(this.state, iid, "def") === f.def) ||
          (f.value !== undefined && M.faithCostStat(this.state, iid, "value") === f.value);
        const avail = [...(me?.hand ?? []), ...(me?.board ?? [])].filter((iid) => iid !== pa.iid && matches(iid));
        const parts = [f.atk !== undefined ? `${f.atk} ATK` : "", f.def !== undefined ? `${f.def} DEF` : "", f.value !== undefined ? `${f.value} VALUE` : ""].filter(Boolean);
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "select",
          options: avail.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: me?.board.includes(iid) ? "board" : "hand" })),
          prompt: `Faith summon — discard a card with ${parts.join(", or ")}` };
        return true;
      }
      this.state = applyIntent(this.state, { kind: "discard", iid: pa.cost[0]! }).state;
      this.finishActivation(pa.targets);
      return false;
    }
    // Resurrection-style COST: discard N cards from your hand (the activating card is in
    // the discard pile, not the hand, so it is never part of the cost), then chain the SS.
    if (spec?.handCost !== undefined) {
      const need = spec.handCost;
      pa.cost ??= [];
      if (pa.cost.length < need) {
        const hand = (this.state.players.find((p) => p.pid === pa.seat)?.hand ?? [])
          .filter((iid) => iid !== pa.iid && !pa.cost!.includes(iid) && !M.isBrick(this.state.instances[iid]?.cardId));
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "discard", picked: [...pa.cost],
          options: hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: `Cost — discard ${need - pa.cost.length} more card(s) from your hand` };
        return true;
      }
      for (const iid of pa.cost) this.state = applyIntent(this.state, { kind: "discard", iid }).state;
      this.finishActivation(pa.targets);
      return false;
    }
    // Depths of Hell COST: banish N OTHER cards from your hand (the summoned card stays),
    // then chain the SS.
    if (spec?.banishHandCost !== undefined) {
      const need = spec.banishHandCost;
      pa.cost ??= [];
      if (pa.cost.length < need) {
        const hand = (this.state.players.find((p) => p.pid === pa.seat)?.hand ?? [])
          .filter((iid) => iid !== pa.iid && !pa.cost!.includes(iid) && !M.isBrick(this.state.instances[iid]?.cardId));
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "banish", picked: [...pa.cost],
          options: hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: `Cost — banish ${need - pa.cost.length} more card(s) from your hand` };
        return true;
      }
      for (const iid of pa.cost) this.state = applyIntent(this.state, { kind: "moveTo", iid, to: "banish" }).state;
      this.finishActivation(pa.targets);
      return false;
    }
    // Holy Grail COST: attach ONE non-effect character (hand or board) to this card as an overlay.
    if (spec?.attachNonEffect) {
      pa.cost ??= [];
      if (pa.cost.length < 1) {
        const me = this.state.players.find((p) => p.pid === pa.seat);
        const pool = [...(me?.hand ?? []), ...(me?.board ?? [])].filter(
          (c) => c !== pa.iid && M.isNonEffect(this.state.instances[c]?.cardId) && !(me!.board.includes(c) && this.state.instances[c]?.faceDown),
        );
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "select",
          options: pool.map((c) => ({ value: c, cardId: this.state.instances[c]?.cardId ?? null, zone: this.zoneOf(c) })),
          prompt: "Holy Grail — attach a non-effect character from your hand or board" };
        return true;
      }
      const card = pa.cost[0]!;
      const from = (this.state.players.find((p) => p.pid === pa.seat)?.hand ?? []).includes(card) ? "hand" : "board";
      this.state = applyIntent(this.state, { kind: "attachOverlay", host: pa.iid, card, from }).state;
      this.finishActivation(pa.targets);
      return false;
    }
    // De-Fusion COST: discard this card, then choose up to `max` copies of `cardId` from your
    // hand / deck / discard to Special Summon (one at a time; "done" stops early).
    if (spec?.deFusion) {
      const { cardId, max } = spec.deFusion;
      pa.cost ??= [];
      const done = pa.cost.includes("done");
      const picks = pa.cost.filter((x) => x !== "done");
      const me = this.state.players.find((p) => p.pid === pa.seat);
      const pool = [...(me?.hand ?? []), ...this.state.mainDeck, ...this.state.discard]
        .filter((c) => this.state.instances[c]?.cardId === cardId && M.canSpecialSummon(cardId) && !picks.includes(c));
      if (!done && picks.length < max && pool.length > 0) {
        const cname = M.cardData(cardId)?.name ?? cardId;
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose",
          options: [...pool.map((c) => ({ value: c, cardId, zone: this.zoneOf(c) })), { value: "done", cardId: null, zone: "", label: "Done" }],
          prompt: `De-Fusion — Special Summon up to ${max} "${cname}" (${picks.length} chosen) — pick one or Done` };
        return true;
      }
      this.state = applyIntent(this.state, { kind: "discard", iid: pa.iid }).state; // "Discard this card"
      this.finishActivation(picks);
      return false;
    }
    // June 4th Incident: pick a Main Deck card whose serial code is formable from this card +
    // 2 hand cards; then the PLAYER picks which 2 hand cards to reveal (only viable ones for
    // that card's code — June 4th itself is always the wild third), then the script fetches
    // it + SS's this.
    if (spec?.serialCode) {
      pa.cost ??= [];
      const others = (this.state.players.find((p) => p.pid === pa.seat)?.hand ?? []).filter((h) => h !== pa.iid);
      if (pa.cost.length === 0) {
        const opts = this.state.mainDeck
          .filter((d) => serialFormable(this.state, others, d))
          .map((d) => ({ value: d, cardId: this.state.instances[d]?.cardId ?? null, zone: "deck" }));
        if (opts.length === 0) { this.finishActivation([]); return false; }
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", options: opts,
          prompt: "How did he know? — search the Main Deck for a card whose serial code you can form" };
        return true;
      }
      const target = pa.cost[0]!;
      const code = idCode(this.state.instances[target]?.cardId ?? "");
      if (pa.cost.length < 3) {
        // steps 2-3: choose the reveals, one at a time, from the cards that can still form the code
        const opts = serialPicks(this.state, others, target, pa.cost.slice(1));
        if (opts.length === 0) { this.finishActivation([]); return false; } // can't happen (search was gated) — fizzle safely
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "reveal", picked: pa.cost.slice(1),
          options: opts.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: `How did he know? — reveal ${3 - pa.cost.length} more card(s) to form code "${code}"` };
        return true;
      }
      const name = (iid?: string) => (iid ? this.state.instances[iid]?.cardId || iid : "?");
      const codeLine = `June 4th Incident: reveals ${name(pa.iid)} + ${name(pa.cost[1])} + ${name(pa.cost[2])} to form code "${code}"`;
      this.finishActivation([target]);
      this.state = M.replace(this.state, { log: [...this.state.log, codeLine] });
      return false;
    }
    // Catbox "Upload": pick a non-Faith hand card (with an Active); the script places it + Catbox
    // in the Extra Zone (its Active then becomes usable by all players).
    if (spec?.upload) {
      pa.cost ??= [];
      const me = this.state.players.find((p) => p.pid === pa.seat);
      if (pa.cost.length === 0) {
        const opts = (me?.hand ?? []).filter((h) => h !== pa.iid && isUploadable(this.state.instances[h]?.cardId ?? ""))
          .map((h) => ({ value: h, cardId: this.state.instances[h]?.cardId ?? null, zone: "hand" }));
        if (opts.length === 0) { this.finishActivation([]); return false; }
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "upload",
          options: opts, prompt: "Upload — choose a non-Faith card (with an Active) to place in the Extra Zone" };
        return true;
      }
      this.finishActivation([pa.cost[0]!]);
      return false;
    }
    // 9 Tailed Fox COST: shuffle the top N of the discard pile into the deck (automatic).
    if (spec?.shuffleDiscardTop !== undefined) {
      for (const iid of this.state.discard.slice(0, spec.shuffleDiscardTop)) {
        this.state = applyIntent(this.state, { kind: "shuffleIntoDeck", iid }).state;
      }
      this.finishActivation(pa.targets);
      return false;
    }
    // A Worthy Disciple (Crimson Chemist): a modal — pick up to 3 DIFFERENT effects, one
    // at a time, each with an optional value/target sub-pick. pa.cost is a flat token list
    // [code, param?, code, param?, ..., "done"?]; resolved effects -> targets as "code:param".
    if (spec?.disciple) {
      const tokens = pa.cost ?? [];
      const needsParam = (c: string) => c === "v" || c === "dd" || c === "ss" || c === "fl";
      const chosen: string[] = []; // completed effect codes
      let pending: string | null = null; // an effect code awaiting its param
      let done = false;
      for (let i = 0; i < tokens.length; ) {
        const t = tokens[i]!;
        if (t === "done") { done = true; break; }
        if (needsParam(t)) { if (i + 1 < tokens.length) { chosen.push(t); i += 2; } else { pending = t; i += 1; } }
        else { chosen.push(t); i += 1; }
      }
      const me = this.state.players.find((p) => p.pid === pa.seat);
      const oppChars = () => this.state.players.filter((p) => p.pid !== pa.seat && !p.eliminated)
        .flatMap((p) => p.board).filter((iid) => !this.state.instances[iid]?.faceDown && this.state.instances[iid]?.cardId != null);
      const ssHandCards = () => (me?.hand ?? []).filter((iid) => [2, 5, 8].includes(M.valueOf(this.state, iid) ?? -1));
      type Opt = { value: string; cardId: string | null; zone: string; label?: string };
      // a sub-pick (param) for the pending effect
      if (pending) {
        let options: Opt[] = [];
        if (pending === "v") options = [1, 5, 10].map((n) => ({ value: String(n), cardId: null, zone: "", label: `Change VALUE to ${n}` }));
        else if (pending === "dd") options = [2, 4, 6].map((n) => ({ value: String(n), cardId: null, zone: "", label: `Discard opponents with DEF ${n}` }));
        else if (pending === "ss") options = ssHandCards().map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" }));
        else options = oppChars().map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "board" })); // fl
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", options, prompt: "A Worthy Disciple — choose this effect's option" };
        return true;
      }
      // all picks made (Done, or 3 effects): encode and resolve
      if (done || chosen.length >= 3) {
        const targets: string[] = [];
        for (let i = 0; i < tokens.length; ) {
          const t = tokens[i]!;
          if (t === "done") break;
          if (needsParam(t)) { targets.push(`${t}:${tokens[i + 1]}`); i += 2; } else { targets.push(`${t}:`); i += 1; }
        }
        this.finishActivation(targets);
        return false;
      }
      // offer the next effect (only those still possible and not already chosen) + Done
      const used = new Set(chosen);
      const opts: Opt[] = [];
      if (!used.has("v")) opts.push({ value: "v", cardId: null, zone: "", label: "Change this card's VALUE (1/5/10)" });
      if (!used.has("dd")) opts.push({ value: "dd", cardId: null, zone: "", label: "Discard all opponent characters with 2/4/6 DEF" });
      if (!used.has("ss") && ssHandCards().length > 0) opts.push({ value: "ss", cardId: null, zone: "", label: "Special Summon a VALUE 2/5/8 card from hand" });
      if (!used.has("sb") && this.state.discard.length > 0) opts.push({ value: "sb", cardId: null, zone: "", label: "Special Summon the bottom card of the discard pile" });
      if (!used.has("dr")) opts.push({ value: "dr", cardId: null, zone: "", label: "Draw 1 card" });
      if (!used.has("fl") && oppChars().length > 0) opts.push({ value: "fl", cardId: null, zone: "", label: "Flip an opponent character face-down (until end of their next turn)" });
      if (chosen.length >= 1 || opts.length === 0) opts.push({ value: "done", cardId: null, zone: "", label: "Done choosing" });
      this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", options: opts, prompt: `A Worthy Disciple — choose effect ${chosen.length + 1} of up to 3 (or Done)` };
      return true;
    }
    // Secret Rumors-style pre-colon COST: place N hand cards face-down on your board
    // (picked one at a time); the placed iids append to the link's targets.
    if (spec?.placeFaceDownCost) {
      const need = spec.placeFaceDownCost;
      pa.cost ??= [];
      if (pa.cost.length < need) {
        const hand = (this.state.players.find((p) => p.pid === pa.seat)?.hand ?? [])
          .filter((iid) => iid !== pa.iid && !pa.cost!.includes(iid) && !M.isBrick(this.state.instances[iid]?.cardId));
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "set",
          options: hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: `Cost — place ${need - pa.cost.length} more card(s) face-down on your board` };
        return true;
      }
      for (const iid of pa.cost) this.state = applyIntent(this.state, { kind: "setFaceDown", iid, player: pa.seat }).state;
      this.finishActivation([...pa.targets, ...pa.cost]); // carry the placed iids to the effect
      return false;
    }
    // Honest Gamble's pre-colon: the targeted opponent reveals a random hand card and the
    // activator reveals a random hand card (both public) -> targets [oppSeat, oppCard, myCard].
    if (spec?.honestGamble) {
      const target = Number(pa.targets[0] ?? "-1");
      const opp = this.state.players.find((p) => p.pid === target);
      const me = this.state.players.find((p) => p.pid === pa.seat);
      let st = this.state.rngState;
      let oppCard = "", myCard = "";
      if (opp && opp.hand.length > 0) { const r = nextInt(st, opp.hand.length); st = r.state; oppCard = opp.hand[r.value]!; }
      if (me && me.hand.length > 0) { const r = nextInt(st, me.hand.length); st = r.state; myCard = me.hand[r.value]!; }
      const name = (iid: string) => (iid ? this.state.instances[iid]?.cardId || iid : "(none)");
      const gambleLine = `Honest Gamble: player ${target} reveals ${name(oppCard)}, player ${pa.seat} reveals ${name(myCard)}`;
      this.state = M.replace(this.state, { rngState: st });
      this.finishActivation([String(target), oppCard, myCard]);
      this.state = M.replace(this.state, { log: [...this.state.log, gambleLine] });
      return false;
    }
    // Honestest Gamble's pre-colon: the targeted opponent CHOOSES a hand card to reveal,
    // then the activator CHOOSES one (each picked via the hand-click UI, accumulated in
    // pa.cost) -> targets [oppSeat, oppCard, myCard]. An empty hand = no card to reveal.
    if (spec?.honestestGamble) {
      const target = Number(pa.targets[0] ?? "-1");
      const opp = this.state.players.find((p) => p.pid === target);
      const me = this.state.players.find((p) => p.pid === pa.seat);
      pa.cost ??= [];
      if (pa.cost.length === 0) {
        if (!opp || opp.hand.length === 0) { this.finishActivation([String(target)]); return false; }
        this.pendingResolve = { player: target, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "reveal",
          options: opp.hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: "Honestest Gamble — choose a card from your hand to reveal" };
        return true;
      }
      if (pa.cost.length === 1) {
        if (!me || me.hand.length === 0) { this.finishActivation([String(target), pa.cost[0]!]); return false; }
        this.pendingResolve = { player: pa.seat, effectId: pa.eid, linkIdx: -1, mode: "choose", handPick: "reveal",
          options: me.hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: "Honestest Gamble — choose a card from your hand to reveal" };
        return true;
      }
      const oppCard = pa.cost[0]!, myCard = pa.cost[1]!;
      const name = (iid: string) => this.state.instances[iid]?.cardId || iid;
      const gambleLine = `Honestest Gamble: player ${target} reveals ${name(oppCard)}, player ${pa.seat} reveals ${name(myCard)}`;
      this.finishActivation([String(target), oppCard, myCard]);
      this.state = M.replace(this.state, { log: [...this.state.log, gambleLine] });
      return false;
    }
    // Log Review's pre-colon: reveal the top card (public) -> targets[0]; set opt iff it
    // could meld with 2 of the controller's face-up board cards (Copebots).
    if (spec?.logReview) {
      const T = this.state.mainDeck[0];
      if (T === undefined) { this.finishActivation([]); return false; }
      const reviewLine = `Log Review: player ${pa.seat} reveals ${this.state.instances[T]?.cardId || T}`;
      const board = (this.state.players.find((p) => p.pid === pa.seat)?.board ?? [])
        .filter((b) => !this.state.instances[b]?.faceDown && this.state.instances[b]?.cardId !== null);
      const tv = M.valueOf(this.state, T);
      let canMeld = false;
      for (let i = 0; i < board.length && !canMeld; i++)
        for (let j = i + 1; j < board.length; j++)
          if (M.meldKind([tv, M.valueOf(this.state, board[i]!), M.valueOf(this.state, board[j]!)]) !== null) { canMeld = true; break; }
      this.finishActivation([T], canMeld); // targets=[T]; opt = "could meld" -> give to an opponent, else draw
      this.state = M.replace(this.state, { log: [...this.state.log, reviewLine] });
      return false;
    }
    // Haitei Raoyue's pre-colon: reveal & draw the bottom card of the deck; its iid
    // becomes targets[0] (the forced material for the optional meld).
    if (spec?.drawBottom) {
      const seat = pa.seat; // finishActivation clears pendingActivation — capture first
      const r = applyIntent(this.state, { kind: "draw", player: seat, count: 1, from: "bottom" });
      this.state = r.state;
      const drawn = Array.isArray(r.result) ? r.result[0] : undefined;
      this.finishActivation(drawn ? [drawn] : []);
      // log the reveal AFTER the activation announce, so the log reads
      // declaration -> reveal -> resolution (not reveal-before-acts)
      if (drawn) {
        const v = M.valueOf(this.state, drawn); // revealed => value is public
        this.state = M.replace(this.state, { log: [...this.state.log, `Haitei Raoyue: player ${seat} reveals and draws ${this.state.instances[drawn]?.cardId || drawn} (${v === null ? "☆" : v})`] });
      }
      return false;
    }
    // iTunes Gift Card: the targeted opponent decides whether to redeem (-> link.opt).
    if (spec?.redeem) {
      const target = Number(pa.targets[0] ?? "-1");
      if (pa.opt === undefined) {
        this.pendingResolve = { player: target, effectId: pa.eid, linkIdx: -1, mode: "opt", options: [], prompt: "Redeem this card? (add it to your hand; the activator draws 2 — else they Special Summon it)" };
        return true;
      }
      this.finishActivation(pa.targets, pa.opt);
      return false;
    }
    this.finishActivation(pa.targets);
    return false;
  }

  /** "Reveal cards from the top of the deck until N with VALUE >= min": public
   *  (logged for everyone); the cards stay in the deck — the resolution moves the
   *  hits to the hand and shuffles. Returns the hit iids. ☆ has no VALUE — never a hit. */
  private runExcavate(seat: Seat, spec: { count: number; minValue: number }): { hits: string[]; line: string } {
    const revealed: string[] = [];
    const hits: string[] = [];
    for (const iid of this.state.mainDeck) {
      revealed.push(iid);
      const v = M.valueOf(this.state, iid);
      if (v !== null && v >= spec.minValue) {
        hits.push(iid);
        if (hits.length >= spec.count) break;
      }
    }
    const names = revealed.map((iid) => {
      const v = M.valueOf(this.state, iid);
      return `${this.state.instances[iid]?.cardId || iid} (${v === null ? "☆" : v})`;
    });
    return { hits, line: `player ${seat} reveals from the deck: ${names.join(", ")} (${hits.length} with VALUE ${spec.minValue}+)` };
  }

  /** Announce the pending activation's link with the decided targets/opt baked in. */
  private finishActivation(targets: string[], opt?: boolean): void {
    const pa = this.pendingActivation!;
    this.announceActivation(pa.seat, pa.iid, pa.role, targets.length ? targets : undefined, opt, pa.as);
    this.pendingActivation = null;
  }

  /** Drive priority/resolution to the next stable state (or a prompt). */
  private settle(): ApplyResult {
    for (let guard = 0; guard < 1000; guard++) {
      // A winner set mid-resolution (Deus ex Machina) ends the game immediately.
      if (this.state.winner !== null) {
        this.state = M.replace(this.state, { phase: M.Phase.GAME_OVER });
        break;
      }
      // 0. State-based discard (Ryuuka Thighnergy, MJG-C05): a face-up copy with 0 DEF
      //    is discarded. Run first so its discard event is processed below.
      if (this.discardZeroDef()) {
        this.passed.clear();
        continue;
      }
      // Freed Jyanshi (MJG-000): controller with 10+ cards in hand discards it.
      if (this.discardFreed()) {
        this.passed.clear();
        continue;
      }
      // 1. Process queued trigger events FIRST (any phase): collect, place them on
      //    the stack (optional ones prompt their controller). Doing this before
      //    resolving the next link keeps triggers on top (LIFO) and lets optional
      //    triggers spawned mid-resolution prompt too.
      if (this.state.events.length > 0) {
        this.passed.clear();
        if (this.beginTriggerBatch() === "await") return { ok: true }; // optional-trigger prompt
        continue;
      }
      // 2. Open window: prompt a responder, else resolve one link/step (or close if
      //    empty). Strict PSCT: a partially-resolved link whose NEXT step is NOT
      //    respondable (`and`/`also`/`if you do`) resolves immediately with no window.
      if (WINDOW(this.state.phase)) {
        if (!this.midResolutionNoWindow()) {
          const responder = this.nextResponder();
          if (responder !== null) {
            this.awaiting = responder;
            return { ok: true };
          }
        }
        // LIVE! (Spinzaku): a saved card with SEVERAL candidate hosts — the owner picks
        // which character it overlays on top of (no-op when nothing is waiting).
        if (this.maybePromptLivePlacement()) return { ok: true };
        // Mana Extraction (Chocolate Cup): an optional attach-the-loser prompt before the
        // battle-discard window finalizes (no-op outside that window).
        if (this.maybePromptManaExtraction()) return { ok: true };
        // Minimum Wage (CEOofLuckshitting): start-of-turn gives (no-op outside that window).
        if (this.maybePromptWage()) return { ok: true };
        // Tuorps (Blood Sprout): start-of-turn self-discard (no-op outside that window).
        if (this.maybePromptTuorps()) return { ok: true };
        // about to resolve the top link/step: if it CHOOSES at resolution, prompt first.
        if (this.maybePromptResolveChoice()) return { ok: true };
        // Gate of Babyron (Cum Chalice): when its Spell link resolves, queue the rampage; the
        // link itself resolves as a no-op and the sequence runs at stable MAIN (below).
        const top = this.state.chain[this.state.chain.length - 1];
        if (top?.script && top.script.cardId === "MJG-C26" && top.script.role === "bottom" && !this.pendingBabylon) {
          this.pendingBabylon = { controller: top.sourcePlayer, chalice: top.script.self, stage: "summon" };
        }
        // remember whose effect just resolved: the post-resolution window counts as a
        // reaction to THAT player for "auto" toggles (Shoumakyou fires exactly there)
        if (top) this.lastResolvedBy = top.script?.controller ?? top.sourcePlayer;
        this.reduce({ type: M.ActionType.RESOLVE_TOP });
        this.passed.clear();
        continue;
      }
      // out of the window: the post-resolution reaction context is over
      this.lastResolvedBy = null;
      if (this.state.chain.length === 0) this.colludeAcked = null;
      // Class Card: the deferred "also, attach it" — runs once the copied Active has
      // resolved. Fizzles silently if the revealed card left the hand in the meantime.
      if (this.pendingClassAttach) {
        const { host, card } = this.pendingClassAttach;
        this.pendingClassAttach = null;
        if (this.state.players.some((p) => p.hand.includes(card)) && this.state.players.some((p) => p.board.includes(host))) {
          this.attachOverlay(host, card);
        } else {
          this.state = M.replace(this.state, { log: [...this.state.log, `Class Card: ${this.state.instances[card]?.cardId || card} is no longer in the hand — the attach fizzles`] });
        }
        continue; // re-settle with the attach applied
      }
      // Mass discards (BAAAANG, Rebirth's wipe, Noir Attack, Explosive Aria): ONE card
      // per pass — its events/triggers process first, then a response window opens,
      // then the next card. Cards that moved zones in the meantime are skipped.
      if (this.massWindow) {
        const mw = this.massWindow;
        this.massWindow = null;
        // the window is a REACTION to the discarding effect's controller — without
        // this, "auto" toggles are never prompted and the queue drains invisibly
        this.lastResolvedBy = mw.by ?? null;
        this.passed.clear();
        this.reduce({ type: M.ActionType.OPEN_WINDOW, returnPhase: this.state.phase });
        continue;
      }
      if (this.state.pendingEffectDiscards.length > 0 && this.state.phase !== M.Phase.FORCED_DISCARD
        && !this.state.pendingBattle && this.state.pendingDiscards.length === 0) {
        const g = this.state.pendingEffectDiscards[0]!;
        const present = g.iids.filter((iid) => this.state.players.some((p) => !p.eliminated && (p.hand.includes(iid) || p.board.includes(iid))));
        if (present.length === 0) { // the whole group moved zones meanwhile
          this.state = M.replace(this.state, { pendingEffectDiscards: this.state.pendingEffectDiscards.slice(1) });
          continue;
        }
        const chooser = g.chooser !== undefined && this.state.players.some((p) => p.pid === g.chooser && !p.eliminated) ? g.chooser : undefined;
        if (chooser !== undefined && present.length > 1) {
          // the owner picks which of their cards falls next (hand pick / board click)
          const allHand = present.every((iid) => this.state.players.find((p) => p.pid === chooser)?.hand.includes(iid));
          this.pendingResolve = { player: chooser, effectId: g.source ?? "mass:discard", linkIdx: -1, mode: "choose", massPick: true,
            ...(allHand ? { handPick: "discard" } : {}),
            options: present.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: this.zoneOf(iid) })),
            prompt: "Mass discard — choose the next card to discard" };
          return { ok: true };
        }
        const iid = present[0]!;
        const rest = g.iids.filter((x) => x !== iid);
        this.state = M.replace(this.state, {
          pendingEffectDiscards: rest.length
            ? [{ ...g, iids: rest }, ...this.state.pendingEffectDiscards.slice(1)]
            : this.state.pendingEffectDiscards.slice(1),
        });
        this.state = applyIntent(this.state, { kind: "discard", iid }, g.by, g.source).state;
        this.massWindow = { by: g.by };
        this.passed.clear();
        continue;
      }
      // LIVE! placement can also surface at a stable phase (safety net)
      if (this.maybePromptLivePlacement()) return { ok: true };
      // Gate of Babyron: drive the mass-summon-and-attack at stable MAIN (between battles).
      if (this.pendingBabylon && this.state.phase === M.Phase.MAIN_PHASE) {
        if (this.advanceBabylon()) return { ok: true }; // paused for an attack-target pick
        continue; // summoned a card / declared a battle / finished -> re-settle
      }
      // Monopoly: an effect scheduled "immediately end your turn" — end it now that we're stable.
      if (this.state.pendingEndTurn !== null && this.state.phase === M.Phase.MAIN_PHASE) {
        const p = this.state.pendingEndTurn;
        this.state = M.replace(this.state, { pendingEndTurn: null });
        if (p === this.state.activePlayer) {
          this.reduce({ type: M.ActionType.OPEN_WINDOW, triggers: collectEndOfTurnTriggers(this.state, p), returnPhase: M.Phase.DISCARD_DOWN });
        }
        continue;
      }
      break; // stable: MAIN (no events) / TURN_START_DRAW / DISCARD_DOWN / TURN_END / GAME_OVER
    }
    this.state = M.winByMelds(this.state); // melds made by an effect can also win
    this.awaiting = null;
    return { ok: true };
  }

  /** Ryuuka Thighnergy (MJG-C05): a state-based check — a face-up, non-negated copy with
   *  0 (or less) DEF is discarded. Returns true if any were discarded (its discard event
   *  is then processed by the settle loop). */
  private discardZeroDef(): boolean {
    const victims = this.state.players
      .flatMap((p) => (p.eliminated ? [] : p.board))
      .filter((iid) => {
        const ci = this.state.instances[iid];
        return ci?.cardId === "MJG-C05" && !ci.faceDown && !M.isEffectNegated(this.state, iid) && M.defOf(this.state, iid) <= 0;
      });
    if (victims.length === 0) return false;
    for (const iid of victims) {
      this.state = applyIntent(this.state, { kind: "discard", iid }).state;
      this.state = M.replace(this.state, { log: [...this.state.log, `${this.state.instances[iid]?.cardId ?? iid} has 0 DEF — discarded (Ryuuka Thighnergy)`] });
    }
    return true;
  }

  /** Freed Jyanshi (MJG-000): a state-based check — a face-up, non-negated copy whose controller
   *  holds 10+ cards in hand is discarded (lifting its "cannot play from hand" lock). */
  private discardFreed(): boolean {
    const victims = this.state.players
      .flatMap((p) => (p.eliminated ? [] : p.board.map((iid) => ({ iid, hand: p.hand.length }))))
      .filter(({ iid, hand }) => {
        const ci = this.state.instances[iid];
        return ci?.cardId === "MJG-000" && !ci.faceDown && !M.isEffectNegated(this.state, iid) && hand >= 10;
      });
    if (victims.length === 0) return false;
    for (const { iid } of victims) {
      this.state = applyIntent(this.state, { kind: "discard", iid }).state;
      this.state = M.replace(this.state, { log: [...this.state.log, `${this.state.instances[iid]?.cardId ?? iid} — its controller has 10+ cards in hand — discarded (Freed Jyanshi)`] });
    }
    return true;
  }

  /** Collect the queued events' triggers (SEGOC order), drain the events, then
   *  decide/place them — prompting the controller for each OPTIONAL trigger. */
  private beginTriggerBatch(): "await" | "done" {
    const trigs = collectTriggers(this.state, this.state.events);
    this.reduce({ type: M.ActionType.CLEAR_EVENTS });
    const seats = this.state.seating.length ? [...this.state.seating] : this.state.players.filter((p) => !p.eliminated).map((p) => p.pid);
    this.trigQueue = orderSimultaneousTriggers(trigs, seats, this.state.activePlayer).map((i) => trigs[i]!);
    this.trigReady = [];
    return this.advanceTriggers();
  }

  /** Walk the trigger queue: mandatory triggers are readied; the first optional one
   *  (that has a legal play) sets pendingChoice and pauses. When empty, place the
   *  accepted triggers as a SEGOC batch (which opens a response window). */
  private advanceTriggers(): "await" | "done" {
    while (this.trigQueue.length > 0) {
      const t = this.trigQueue[0]!;
      const eid = t.id ?? "";
      const [cardId, role] = eid.split(":");
      const ct = cardId && role ? getTrigger(cardId, role) : undefined;
      if (ct?.optional) {
        // the chain toggle governs REACTIONS to other players: a seat with its
        // toggle OFF silently declines hand-trap-style optional triggers (M12's
        // fOUnD mEeEeee, Call Slut). Own-event offers (Banana's Ehe…, Watapon)
        // always prompt — they aren't chain reactions.
        if (this.toggleOf(t.player) === "off" && (ct.scope ?? "").startsWith("opponent")) { this.trigQueue.shift(); continue; }
        const self = t.script?.self ?? "";
        const candidates = triggerTargets(eid, this.state, self, t.player);
        if (triggerNeedsTargets(eid) && candidates.length === 0) { this.trigQueue.shift(); continue; } // no legal play -> skip
        this.pendingChoice = { player: t.player, effectId: eid, self, candidates };
        return "await";
      }
      this.trigReady.push(this.trigQueue.shift()!);
    }
    if (this.trigReady.length > 0) this.reduce({ type: M.ActionType.OPEN_TRIGGER_BATCH, triggers: this.trigReady });
    this.trigReady = [];
    return "done";
  }

  /** Is any 3-card combination of this hand a valid meld? (for the >dama hand-meld copy) */
  private handMeldPossible(hand: readonly string[]): boolean {
    const vals = hand.map((iid) => M.valueOf(this.state, iid));
    for (let i = 0; i < vals.length - 2; i++)
      for (let j = i + 1; j < vals.length - 1; j++)
        for (let k = j + 1; k < vals.length; k++)
          if (M.meldKind([vals[i]!, vals[j]!, vals[k]!]) !== null) return true;
    return false;
  }

  /** Replace a Belly Dance link with the copied Active (so it resolves as that
   *  ability), or clear its script to a no-op when there's nothing to copy. */
  private transformBelly(linkIdx: number, copied: { cardId: string; role: "top" | "bottom"; self: string; controller: Seat; targets: string[] } | null): void {
    this.state = M.replace(this.state, {
      chain: this.state.chain.map((l, i) =>
        i === linkIdx
          ? copied
            ? { ...l, effectId: `${copied.cardId}:${copied.role}`, script: { cardId: copied.cardId, role: copied.role, self: copied.self, controller: copied.controller, targets: copied.targets, bellyCopy: true } }
            : { ...l, script: l.script ? { ...l.script, targets: [] } : l.script }
          : l,
      ),
    });
  }

  /** "Class Card" (Strawberry Cup): attach a revealed hand card to `host` as an overlay
   *  (so `host` gains its ATK via the MJG-C23:top aura). No-op if the host left play or the
   *  card is no longer in a hand. */
  private attachOverlay(host: string, card: string): void {
    const hc = this.state.instances[host];
    if (!hc || !this.state.players.some((p) => p.hand.includes(card))) return;
    this.state = M.replace(this.state, {
      players: this.state.players.map((p) => ({ ...p, hand: p.hand.filter((h) => h !== card) })),
      instances: { ...this.state.instances, [host]: { ...hc, overlays: [...hc.overlays, card] } },
      log: [...this.state.log, `${this.state.instances[card]?.cardId || card} is attached to ${hc.cardId || host} as an overlay (Class Card)`],
    });
  }

  /** CEOofLuckshitting "Minimum Wage" (Passive, mandatory): at the start of the active player's
   *  turn, queue every OTHER player who controls a live Minimum Wage to give N cards from their
   *  hand to the active player (N=2 in a 2-player game, else 1). Driven by maybePromptWage. */
  /** Resolve the turn draw + open the start-of-turn window (factored so "Ya Boy"'s
   *  Fortune Teller scry can run first and resume it). */
  private doTurnDraw(): void {
    this.reduce({ type: M.ActionType.DRAW_RESOLVES });
    // start-of-turn is an open window (FAQ): batched start-of-turn triggers + quick
    // effects / YUZU, then back to the main phase. "Minimum Wage" (MJG-M05) resolves here.
    if (this.state.phase === M.Phase.MAIN_PHASE) {
      this.reduce({ type: M.ActionType.OPEN_WINDOW, returnPhase: M.Phase.MAIN_PHASE });
      this.setupWage();
      this.setupTuorps();
    }
  }

  /** "Ya Boy" Fortune Teller (MJG-M20): if the active player controls a live Ya Boy and
   *  the deck is non-empty, show them the top card and offer to place it on the bottom
   *  before the turn draw. Returns true if it prompted (the draw waits). */
  private maybePromptFortune(seat: Seat): boolean {
    if (this.state.mainDeck.length === 0) return false;
    const hasYaBoy = this.state.players.some((p) => !p.eliminated && p.pid === seat && p.board.some((b) => {
      const yb = this.state.instances[b];
      return yb?.cardId === "MJG-M20" && !yb.faceDown && !M.isEffectNegated(this.state, b);
    }));
    if (!hasYaBoy) return false;
    const top = this.state.mainDeck[0]!;
    const v = M.valueOf(this.state, top);
    const name = M.cardData(this.state.instances[top]?.cardId ?? "")?.name ?? this.state.instances[top]?.cardId ?? "a card";
    void name; void v; // the card is shown as a clickable link (preview), not inlined
    this.pendingFortune = { seat };
    this.pendingResolve = { player: seat, effectId: "MJG-M20:top", linkIdx: -1, mode: "opt", options: [], optional: true,
      previewIid: top, prompt: "Fortune Teller — the top card of the deck is" };
    return true;
  }

  private setupWage(): void {
    const recipient = this.state.activePlayer;
    const n = this.state.players.filter((p) => !p.eliminated).length === 2 ? 2 : 1;
    const queue = this.state.players
      .filter((p) => !p.eliminated && p.pid !== recipient &&
        p.board.some((iid) => this.state.instances[iid]?.cardId === "MJG-M05" && !this.state.instances[iid]?.faceDown && !M.isEffectNegated(this.state, iid)))
      .map((p) => ({ giver: p.pid, remaining: n }));
    if (queue.length > 0) this.pendingWage = { recipient, queue };
  }

  /** Drive the Minimum Wage gives: the head giver picks one hand card to hand to the recipient,
   *  until they've given their quota (or run out of cards), then the next giver. Returns true if
   *  it set a prompt (paused). */
  private maybePromptWage(): boolean {
    const w = this.pendingWage;
    if (!w) return false;
    while (w.queue.length > 0) {
      const head = w.queue[0]!;
      const hand = this.state.players.find((p) => p.pid === head.giver)?.hand ?? [];
      if (head.remaining <= 0 || hand.length === 0) { w.queue.shift(); continue; }
      this.pendingResolve = { player: head.giver, effectId: "MJG-M05:bottom", linkIdx: -1, mode: "choose", handPick: "give",
        options: hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
        prompt: `Minimum Wage — give ${head.remaining} card(s) from your hand to player ${w.recipient}` };
      return true;
    }
    this.pendingWage = null;
    return false;
  }

  /** Blood Sprout "Tuorps" (Passive): at the start of the active player's turn (after drawing),
   *  they discard 1 card of their choice per OFF-turn controller of a live Blood Sprout. */
  private setupTuorps(): void {
    const player = this.state.activePlayer;
    const count = this.state.players.filter((p) => !p.eliminated && p.pid !== player &&
      p.board.some((iid) => this.state.instances[iid]?.cardId === "MJG-410" && !this.state.instances[iid]?.faceDown && !M.isEffectNegated(this.state, iid))).length;
    if (count > 0) this.pendingTuorps = { player, remaining: count };
  }

  /** Prompt the active player to discard one card per pending Blood Sprout. Returns true if it
   *  set a prompt (paused). */
  private maybePromptTuorps(): boolean {
    const t = this.pendingTuorps;
    if (!t) return false;
    const hand = choosableHand(this.state, this.state.players.find((p) => p.pid === t.player)?.hand ?? []);
    if (t.remaining > 0 && hand.length > 0) {
      this.pendingResolve = { player: t.player, effectId: "MJG-410:bottom", linkIdx: -1, mode: "choose", handPick: "discard",
        options: hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
        prompt: `Blood Sprout — choose ${t.remaining} card(s) to discard from your hand` };
      return true;
    }
    this.pendingTuorps = null;
    return false;
  }

  /** Chocolate Cup "Mana Extraction" (Passive): during the battle-discard window, if a live
   *  Chocolate is the discarder of a pending battle loser, offer its controller the option to
   *  attach that loser as an overlay instead of discarding it. Returns true if it set a prompt. */
  /** LIVE! (MJG-C21): a saved Spinzaku with SEVERAL candidate hosts waits off-board —
   *  prompt its owner to pick the character it overlays on top of. Candidates are
   *  recomputed at prompt time: one left -> place immediately; none -> Faith shuffle. */
  private maybePromptLivePlacement(): boolean {
    if (this.pendingResolve !== null) return false; // one prompt at a time
    const pl = this.state.pendingLivePlacements[0];
    if (!pl) return false;
    const candidates = this.state.players.flatMap((p) =>
      p.eliminated ? [] : p.board.filter((x) => !this.state.instances[x]?.faceDown));
    if (candidates.length === 0) {
      // hosts vanished while waiting: fall back to the Faith-deck shuffle
      const sh = shuffleWith(this.state.rngState, [...this.state.faithDeck, pl.iid]);
      this.state = M.replace(this.state, {
        rngState: sh.state, faithDeck: sh.value,
        pendingLivePlacements: this.state.pendingLivePlacements.filter((x) => x.iid !== pl.iid),
        log: [...this.state.log, `${this.state.instances[pl.iid]?.cardId} is shuffled into the Faith Deck instead of leaving play (LIVE!)`],
      });
      return false;
    }
    if (candidates.length === 1) {
      this.state = M.liveCover(this.state, pl.iid, candidates[0]!);
      return false;
    }
    this.pendingLive = { iid: pl.iid, controller: pl.controller };
    this.pendingResolve = { player: pl.controller, effectId: "MJG-C21:bottom", linkIdx: -1, mode: "choose",
      options: candidates.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "board" })),
      prompt: `LIVE! — choose a character for ${this.state.instances[pl.iid]?.cardId} to overlay on top of` };
    return true;
  }

  private maybePromptManaExtraction(): boolean {
    if (this.state.pendingDiscards.length === 0) { this.manaOffered.clear(); return false; }
    for (const { iid: loser, by } of this.state.pendingDiscards) {
      if (this.manaOffered.has(loser)) continue;
      const host = this.state.instances[by];
      if (!host || host.cardId !== "MJG-C25" || host.faceDown || M.isEffectNegated(this.state, by)) continue;
      // "attach it to THIS" — only when Chocolate Cup SURVIVES the battle; if it's itself
      // being discarded by the same battle, there's nothing to attach the loser to.
      if (this.state.pendingDiscards.some((pd) => pd.iid === by)) continue;
      const owner = this.state.players.find((p) => p.board.includes(by))?.pid;
      if (owner === undefined) continue; // the Chocolate left play
      this.manaOffered.add(loser);
      if (!this.state.players.some((p) => p.board.includes(loser))) continue; // loser already saved
      // a MANDATORY would-be-discarded replacement on the loser (LIVE! / C.C.) takes
      // precedence over this OPTIONAL one — offering Mana Extraction here would let the
      // player choose to skip a (Mandatory) passive.
      if (M.liveRedirect(this.state, loser) !== null || M.pizzaHutCode(this.state, loser) !== null) continue;
      this.manaPending = { loser, host: by };
      this.pendingResolve = { player: owner, effectId: "MJG-C25:bottom", linkIdx: -1, mode: "opt", options: [],
        prompt: `Mana Extraction — attach ${this.state.instances[loser]?.cardId || loser} to ${host.cardId} as an overlay instead of discarding it?` };
      return true;
    }
    return false;
  }

  /** Cum Chalice "Gate of Babyron": advance the rampage one step at stable MAIN. In "summon"
   *  stage it Special Summons the next hand card (chalice first); when the hand is empty it
   *  finishes (bounce + end turn). In "attack" stage it prompts for the just-summoned card's
   *  target (mandatory if any legal target exists) — or skips to the next summon if it can't
   *  attack. Returns true if it set a prompt (paused). */
  private advanceBabylon(): boolean {
    const b = this.pendingBabylon!;
    const me = () => this.state.players.find((p) => p.pid === b.controller)!;
    if (b.stage === "summon") {
      const hand = me().hand;
      if (hand.length === 0) { this.finishBabylon(); return false; }
      const next = hand.includes(b.chalice) ? b.chalice : hand[0]!; // this card first
      this.state = applyIntent(this.state, { kind: "specialSummon", iid: next, controller: b.controller }).state;
      b.stage = "attack";
      b.attacker = next;
      return false;
    }
    // "attack" stage
    const attacker = b.attacker!;
    const canAtk = me().board.includes(attacker) && !this.state.instances[attacker]?.faceDown && !this.state.instances[attacker]?.tapped && !this.state.instances[attacker]?.stunned && !M.cannotAttack(this.state, attacker);
    const targets = canAtk
      ? this.state.players.flatMap((p) => (p.pid === b.controller || p.eliminated ? [] : p.board))
          .filter((t) => !this.state.instances[t]?.faceDown && !M.cannotBeAttacked(this.state, t) && !M.matchmakerBonded(this.state, attacker, t))
      : [];
    if (targets.length === 0) { b.stage = "summon"; b.attacker = undefined; return false; } // can't attack -> next summon
    this.pendingResolve = { player: b.controller, effectId: "MJG-C26:bottom", linkIdx: -1, mode: "choose",
      options: targets.map((t) => ({ value: t, cardId: this.state.instances[t]?.cardId ?? null, zone: "board" })),
      prompt: `Gate of Babyron — choose a target for ${this.state.instances[attacker]?.cardId || attacker} to attack` };
    return true;
  }

  /** Gate of Babyron finish: return every board card EXCEPT the chalice to your hand, then end
   *  the turn immediately. */
  private finishBabylon(): void {
    const b = this.pendingBabylon!;
    const board = [...(this.state.players.find((p) => p.pid === b.controller)?.board ?? [])];
    for (const iid of board) {
      if (iid === b.chalice) continue;
      this.state = applyIntent(this.state, { kind: "moveToHand", iid, player: b.controller }).state;
    }
    this.state = M.replace(this.state, { log: [...this.state.log, `Gate of Babyron: player ${b.controller} returns their board (except Cum Chalice) to hand and ends their turn`] });
    this.pendingBabylon = null;
    this.reduce({ type: M.ActionType.END_TURN }); // immediately end the turn
  }

  /** Finish a Watson guess: write the subject into the link's targets[0] only when
   *  the guess was correct (so the script banishes it), else clear them. */
  /** End a TSUOM pass: mark the link finished (script.opt) so it isn't restarted. */
  private finishTsuom(linkIdx: number): void {
    this.state = M.replace(this.state, {
      chain: this.state.chain.map((l, i) => (i === linkIdx && l.script ? { ...l, script: { ...l.script, opt: true } } : l)),
    });
    this.pendingTsuom = null;
  }

  /** End a half-discard pass: mark the link finished (script.opt). */
  private finishHalfDiscard(linkIdx: number): void {
    this.state = M.replace(this.state, {
      chain: this.state.chain.map((l, i) => (i === linkIdx && l.script ? { ...l, script: { ...l.script, opt: true } } : l)),
    });
    this.pendingHalfDiscard = null;
  }

  /** Run the multi-player half-discard pass (Beautification Council / Treasurer): each
   *  player anticlockwise from `ctrl` whose hand exceeds `minHand` discards floor(hand/2)
   *  cards of their own choice (the count is locked when the queue is built). SOA-protected
   *  opponents (Temeraire) are exempt. Returns true if it set a prompt (paused), false once
   *  the whole pass is complete (marks the link via finishHalfDiscard). */
  private promptHalfDiscard(idx: number, eid: string, ctrl: Seat, minHand: number, label: string): boolean {
    if (!this.pendingHalfDiscard || this.pendingHalfDiscard.linkIdx !== idx) {
      const seating = this.state.seating.length ? [...this.state.seating] : this.state.players.map((p) => p.pid);
      const queue = seatOrder(seating, ctrl)
        .map((pid) => ({ pid, p: this.state.players.find((q) => q.pid === pid) }))
        .filter(({ pid, p }) => p !== undefined && !p.eliminated && !(pid !== ctrl && M.soaImmune(this.state, pid)) && p.hand.length > minHand)
        .map(({ pid, p }) => ({ seat: pid, remaining: Math.floor(p!.hand.length / 2) }))
        .filter((e) => e.remaining > 0);
      this.pendingHalfDiscard = { linkIdx: idx, queue };
    }
    const ph = this.pendingHalfDiscard;
    while (ph.queue.length > 0) {
      const head = ph.queue[0]!;
      const hand = this.state.players.find((p) => p.pid === head.seat)?.hand ?? [];
      // The Brick ([B]) cannot be discarded from a hand -> not a valid pick.
      const pickable = hand.filter((iid) => !M.isBrick(this.state.instances[iid]?.cardId));
      if (head.remaining <= 0 || pickable.length === 0) { ph.queue.shift(); continue; }
      this.pendingResolve = { player: head.seat, effectId: eid, linkIdx: idx, mode: "choose", handPick: "discard",
        options: pickable.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
        prompt: `${label} — discard ${head.remaining} more card(s) from your hand` };
      return true;
    }
    this.finishHalfDiscard(idx);
    return false;
  }

  /** End a succ loop: mark the link finished (script.opt) so it isn't restarted. */
  private finishSucc(linkIdx: number): void {
    this.state = M.replace(this.state, {
      chain: this.state.chain.map((l, i) => (i === linkIdx && l.script ? { ...l, script: { ...l.script, opt: true } } : l)),
    });
    this.pendingSucc = null;
  }

  /** End a Simp pick: mark the link finished (script.opt) so it isn't restarted. */
  private finishSimp(linkIdx: number): void {
    this.state = M.replace(this.state, {
      chain: this.state.chain.map((l, i) => (i === linkIdx && l.script ? { ...l, script: { ...l.script, opt: true } } : l)),
    });
    this.pendingSimp = null;
  }

  /** End the G***u parity game: mark the link finished (script.opt) so the
   *  resolve-choice pass doesn't restart it when the link comes back to the top. */
  private finishParity(linkIdx: number): void {
    this.state = M.replace(this.state, {
      chain: this.state.chain.map((l, i) => (i === linkIdx && l.script ? { ...l, script: { ...l.script, opt: true } } : l)),
    });
    this.pendingParity = null;
  }

  private finishGuess(linkIdx: number, subject: string | null): void {
    this.state = M.replace(this.state, {
      chain: this.state.chain.map((l, i) => (i === linkIdx && l.script ? { ...l, script: { ...l.script, targets: subject ? [subject] : [] } } : l)),
    });
    this.pendingGuess = null;
  }

  /** If the top link DECIDES at resolution (choose a candidate, then an optional
   *  yes/no) and hasn't yet, set up the next prompt for its controller and pause.
   *  Returns true if it paused. */
  private maybePromptResolveChoice(): boolean {
    const chain = this.state.chain;
    if (chain.length === 0) return false;
    const idx = chain.length - 1;
    const link = chain[idx]!;
    if (!link.script) return false;
    const eid = `${link.script.cardId}:${link.script.role}`;
    // a NEGATED link resolves as a no-op: no resolve-time decisions, no reveal popups
    // (We Gottem / Collusion). Collusion's activation-time show is taken back too.
    if (link.negated) {
      if (RESOLVE_CHOICES[eid]?.optShowsHand) {
        const t = Number(link.script.targets?.[0] ?? "-1");
        this.state = applyIntent(this.state, { kind: "endHandReveal", owner: link.script.controller, viewer: t }).state;
      }
      return false;
    }
    // A Belly-Dance copy resolves the copied Active in place, so its ACTIVATION-time
    // parts run here at resolution instead: an excavate reveal happens inline (no
    // decision), a Watson guess is gathered as a resolve choice.
    if (link.script.bellyCopy && (link.step ?? 0) === 0 && ACTIVATION_CHOICES[eid]?.excavate && !(link.script.targets ?? []).length) {
      const ex = this.runExcavate(link.script.controller, ACTIVATION_CHOICES[eid]!.excavate!);
      this.state = M.replace(this.state, { log: [...this.state.log, ex.line] });
      if (ex.hits.length) {
        this.state = M.replace(this.state, {
          chain: this.state.chain.map((l, i) => (i === idx && l.script ? { ...l, script: { ...l.script, targets: ex.hits } } : l)),
        });
      }
      return false; // no prompt — continue to resolution
    }
    // a copied drawBottom pre-colon (Haitei Raoyue via Belly Dance / Class Card): the
    // reveal+draw happened at ACTIVATION on the normal path — for a copy it runs here,
    // then the usual resolve choices (the meld option) continue with the drawn card.
    if (link.script.bellyCopy && (link.step ?? 0) === 0 && ACTIVATION_CHOICES[eid]?.drawBottom && !(link.script.targets ?? []).length) {
      const r = applyIntent(this.state, { kind: "draw", player: link.script.controller, count: 1, from: "bottom" });
      this.state = r.state;
      const drawn = Array.isArray(r.result) ? r.result[0] : undefined;
      if (!drawn) return false; // empty deck — the copy fizzles
      const v = M.valueOf(this.state, drawn);
      this.state = M.replace(this.state, {
        log: [...this.state.log, `Haitei Raoyue: player ${link.script.controller} reveals and draws ${this.state.instances[drawn]?.cardId || drawn} (${v === null ? "☆" : v})`],
        chain: this.state.chain.map((l, i) => (i === idx && l.script ? { ...l, script: { ...l.script, targets: [drawn] } } : l)),
      });
      return this.maybePromptResolveChoice(); // now offer the meld option as usual
    }
    // i'm in your walls "fOUnD mEeEeee" step 1: the optional one-sided attack. After
    // the SS (step 0), offer a yes/no, then a victim pick among attackable characters
    // the DRAWER (script.drewBy — "they control") controls. No candidates -> no-op.
    if (eid === "MJG-M12:top" && (link.step ?? 0) === 1) {
      const self = link.script.self, drewBy = link.script.drewBy;
      const drawer = drewBy === undefined ? undefined : this.state.players.find((p) => p.pid === drewBy && !p.eliminated);
      const cands = (drawer?.board ?? [])
        .filter((iid) => !this.state.instances[iid]?.faceDown && this.state.instances[iid]?.cardId !== null
          && !M.cannotBeAttacked(this.state, iid) && !M.matchmakerBonded(this.state, self, iid));
      if (cands.length === 0) return false;
      const holder = link.script.controller;
      if (link.script.opt === undefined) {
        this.pendingResolve = { player: holder, effectId: eid, linkIdx: idx, mode: "opt", options: [],
          prompt: "fOUnD mEeEeee — attack a character they control? (it does not fight back)" };
        return true;
      }
      if (link.script.opt === true && !(link.script.targets?.length)) {
        this.pendingResolve = { player: holder, effectId: eid, linkIdx: idx, mode: "choose",
          options: cands.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "board" })),
          prompt: "fOUnD mEeEeee — choose a character to attack (one-sided)" };
        return true;
      }
      return false; // decided -> resolve step 1
    }
    const spec = RESOLVE_CHOICES[eid] ?? (link.script.bellyCopy && (link.step ?? 0) === 0 && ACTIVATION_CHOICES[eid]?.guess ? { guess: true } : undefined);
    if (!spec) return false;
    const ctrl = link.script.controller;
    // Belly Dance: the link's target[0] is the chosen character. Gather which Active
    // to copy (role, if it has 2) and that Active's own activation-targets, then
    // TRANSFORM this link into that Active so the rest resolves normally.
    // Belly Dance copies a chosen controlled character's Active; Class Card (Strawberry Cup)
    // reveals a HAND card with an Active, copies that, and afterwards ATTACHES it as an overlay.
    // Both gather the copied Active's role + targets here, then TRANSFORM this link into that
    // Active so the rest resolves normally.
    if (spec.bellyDance || spec.classCard) {
      if (!this.pendingBelly || this.pendingBelly.linkIdx !== idx) {
        if (spec.classCard) {
          // subject is revealed from hand now; attach it to the source (Strawberry) afterwards
          this.pendingBelly = { linkIdx: idx, controller: ctrl, char: "", targets: [], attachTo: link.script.self, needSubject: true };
        } else {
          const char = link.script.targets?.[0];
          if (!char || activeRoles(this.state.instances[char]?.cardId ?? "").length === 0) { this.transformBelly(idx, null); return false; }
          this.pendingBelly = { linkIdx: idx, controller: ctrl, char, targets: [] };
        }
      }
      const bell = this.pendingBelly;
      // Class Card step 0: reveal a hand card that has an Active ability
      if (bell.needSubject) {
        const hand = this.state.players.find((p) => p.pid === ctrl)?.hand ?? [];
        const cands = hand.filter((iid) => activeRoles(this.state.instances[iid]?.cardId ?? "").length > 0);
        if (cands.length === 0) { this.pendingBelly = null; this.transformBelly(idx, null); return false; } // nothing to copy/attach
        this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", handPick: "reveal",
          options: cands.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: "Reveal a card from your hand and use one of its ACTIVE abilities" };
        return true;
      }
      const cardId = this.state.instances[bell.char]?.cardId ?? "";
      const roles = activeRoles(cardId);
      if (roles.length === 0) { if (bell.attachTo) this.pendingClassAttach = { host: bell.attachTo, card: bell.char }; this.pendingBelly = null; this.transformBelly(idx, null); return false; }
      // step 1: which Active (only ask if there are two)
      if (bell.role === undefined) {
        if (roles.length === 1) bell.role = roles[0];
        else {
          this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", options: roles.map((r) => ({ value: r, cardId: null, zone: "", label: M.abilityTitle(cardId, r) ?? `${r} Active` })) };
          return true;
        }
      }
      const cs = ACTIVATIONS[`${cardId}:${bell.role}`];
      // a >dama-style hand meld: the controller picks 3 hand cards for a special meld
      if (cs?.handMeld) {
        const hand = this.state.players.find((p) => p.pid === ctrl)?.hand ?? [];
        if (!this.handMeldPossible(hand)) { if (bell.attachTo) this.pendingClassAttach = { host: bell.attachTo, card: bell.char }; this.transformBelly(idx, null); this.pendingBelly = null; return false; } // no valid meld -> fizzle
        this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "handMeld", options: [], prompt: "Special meld — pick 3 cards from your hand" };
        return true;
      }
      // step 2: gather the copied Active's own activation-targets
      const need = cs?.targets ?? 0;
      if (bell.targets.length < need) {
        let options: { value: string; cardId: string | null; zone: string; label?: string }[] = [];
        if (cs?.targetKind === "character") options = characterTargets(this.state, cs.targetFilter, ctrl, bell.char).map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "board" }));
        else if (cs?.targetKind === "opponent") options = this.state.players.filter((p) => !p.eliminated && p.pid !== ctrl && (!cs.opponentFilter || cs.opponentFilter(this.state, p.pid, ctrl))).map((p) => ({ value: String(p.pid), cardId: null, zone: "", label: `Player ${p.pid}` }));
        else if (cs?.targetKind === "discard") options = this.state.discard.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "discard" }));
        if (options.length === 0) { if (bell.attachTo) this.pendingClassAttach = { host: bell.attachTo, card: bell.char }; this.transformBelly(idx, null); this.pendingBelly = null; return false; } // can't satisfy -> fizzle
        this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", options };
        return true;
      }
      // all gathered -> become the copied Active & resolve; the "also, attach it" clause
      // is DEFERRED until the copy has resolved (it fizzles if the card left the hand).
      if (bell.attachTo) this.pendingClassAttach = { host: bell.attachTo, card: bell.char };
      this.transformBelly(idx, { cardId, role: bell.role!, self: bell.char, controller: ctrl, targets: [...bell.targets] });
      this.pendingBelly = null;
      return this.maybePromptResolveChoice();
    }
    // G***u "Fatherless Behaviour": up to 3 rounds of (controller picks a hand card ->
    // target guesses odd/even -> wrong guess: the target discards 1 of their choice).
    // The whole game is one `and`-joined PSCT sentence — no response windows inside.
    // A finished game marks the link (script.opt) so it isn't restarted.
    if (spec.parity && link.script.opt === undefined) {
      if (!this.pendingParity || this.pendingParity.linkIdx !== idx) {
        this.pendingParity = { linkIdx: idx, controller: ctrl, target: Number(link.script.targets?.[0] ?? "-1"), round: 1, stage: "pick" };
      }
      const pp = this.pendingParity;
      const myHand = this.state.players.find((p) => p.pid === ctrl)?.hand ?? [];
      const theirHand = this.state.players.find((p) => p.pid === pp.target)?.hand ?? [];
      if (pp.stage === "pick") {
        if (myHand.length === 0) { this.finishParity(idx); return false; } // nothing to choose -> the game ends
        this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", handPick: "reveal",
          options: myHand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: `Round ${pp.round}/3 — reveal a card from your hand (player ${pp.target} guesses its VALUE parity)` };
        return true;
      }
      if (pp.stage === "guess") {
        this.pendingResolve = { player: pp.target, effectId: eid, linkIdx: idx, mode: "choose",
          options: [
            { value: "odd", cardId: null, zone: "", label: "Odd" },
            { value: "even", cardId: null, zone: "", label: "Even (☆ counts as even)" },
          ],
          prompt: `Player ${ctrl} chose a hand card — guess its VALUE parity` };
        return true;
      }
      if (pp.stage === "discard") {
        const pickable = choosableHand(this.state, theirHand);
        if (pickable.length === 0) { pp.stage = "repeat"; return this.maybePromptResolveChoice(); } // nothing (non-Brick) to discard
        this.pendingResolve = { player: pp.target, effectId: eid, linkIdx: idx, mode: "choose", handPick: "discard",
          options: pickable.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: "Wrong guess — discard 1 card from your hand" };
        return true;
      }
      // stage "repeat": a round just finished
      if (pp.round >= 3 || myHand.length === 0) { this.finishParity(idx); return false; }
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "opt", options: [],
        prompt: `Repeat the guessing game? (${pp.round}/3 rounds used)` };
      return true;
    }
    // Explosive Aria (MSGK-C30): pick a hand card, then CLICK a spot on any board —
    // the card is placed there and everything it touches blows up, then itself.
    if (spec.explosiveAria) {
      const picked = (link.script.targets ?? [])[0];
      if (!picked) {
        const hand = (this.state.players.find((p) => p.pid === ctrl)?.hand ?? [])
          .filter((iid) => !M.isBrick(this.state.instances[iid]?.cardId)); // a Brick is never a chosen discard
        if (hand.length === 0) return false; // nothing placeable -> the effect fizzles
        this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", handPick: "place", append: true,
          options: hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: "Explosive Aria — place a card from your hand on a board" };
        return true;
      }
      if (!(link.script.targets ?? [])[1]) {
        this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", options: [], placeCard: picked,
          prompt: "Click a spot on any player's board — every card it touches blows up (and then itself)" };
        return true;
      }
      return false; // picked + placed -> resolve
    }
    // Hand picks decided right BEFORE a given step resolves (NEET's give, Ninjutsu's
    // shuffle-back): pick `count` cards one at a time from `by`'s hand; the picks
    // append to the link's targets after the activation targets.
    if (spec.handAtStep && (link.step ?? 0) === spec.handAtStep.atStep) {
      const base = ACTIVATIONS[eid]?.targets ?? 0;
      const picked = (link.script.targets ?? []).slice(base);
      if (picked.length < spec.handAtStep.count) {
        const who = spec.handAtStep.by === "target" ? Number(link.script.targets?.[0] ?? "-1") : ctrl;
        const flt = spec.handAtStep.filter;
        const hand = (this.state.players.find((p) => p.pid === who)?.hand ?? [])
          .filter((iid) => !picked.includes(iid) && (!flt || flt(this.state, iid, link.script!.self)));
        if (hand.length > 0) {
          this.pendingResolve = { player: who, effectId: eid, linkIdx: idx, mode: "choose", handPick: spec.handAtStep.label, append: true,
            options: hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
            prompt: spec.handAtStep.prompt };
          return true;
        }
        // hand exhausted -> proceed with what was picked
      }
    }
    // Ravioli "succ": attach the pending pick as an overlay, then offer a repeat
    // while a valid (<= current VALUE) target remains. A finished loop marks the
    // link (script.opt) so it isn't restarted.
    if (spec.succ && link.script.opt === undefined) {
      if (!this.pendingSucc || this.pendingSucc.linkIdx !== idx) {
        this.pendingSucc = { linkIdx: idx, pending: link.script.targets?.[0] ?? null, stage: "repeat" };
      }
      const ps = this.pendingSucc;
      const host = link.script.self;
      if (!this.state.players.some((p) => p.board.includes(host))) { this.finishSucc(idx); return false; } // host left play
      if (ps.pending) {
        this.state = applyIntent(this.state, { kind: "attachOverlay", host, card: ps.pending }).state;
        ps.pending = null;
        ps.stage = "repeat";
      }
      const candidates = characterTargets(this.state, ACTIVATIONS[eid]?.targetFilter, ctrl, host);
      if (candidates.length === 0) { this.finishSucc(idx); return false; } // nothing left to succ
      if (ps.stage === "repeat") {
        this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "opt", options: [],
          prompt: "succ — attach another character?" };
        return true;
      }
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose",
        options: candidates.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "board" })),
        prompt: "succ — choose a character to attach" };
      return true;
    }
    // NEET bottom: the TARGET looks at the deck top 3 (shown only to them) and gives
    // AT LEAST 1 to the controller — a mandatory first pick, then optional extras.
    // A finished pick marks the link (script.opt) so it isn't restarted.
    if (spec.simp && link.script.opt === undefined) {
      if (!this.pendingSimp || this.pendingSimp.linkIdx !== idx) {
        const target = Number(link.script.targets?.[0] ?? "-1");
        this.pendingSimp = { linkIdx: idx, target, remaining: this.state.mainDeck.slice(0, 3), stage: "pick" };
      }
      const ps = this.pendingSimp;
      if (ps.remaining.length === 0) { this.finishSimp(idx); return false; } // nothing (left) to give
      if (ps.stage === "pick") {
        this.pendingResolve = { player: ps.target, effectId: eid, linkIdx: idx, mode: "choose", append: true,
          options: ps.remaining.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "deck" })),
          prompt: `Top 3 of the deck — give a card to player ${ctrl}` };
        return true;
      }
      // stage "more": at least one given — offer another (optional)
      this.pendingResolve = { player: ps.target, effectId: eid, linkIdx: idx, mode: "opt", options: [],
        prompt: `Give player ${ctrl} another card? (${ps.remaining.length} left)` };
      return true;
    }
    // The Usual?: the TARGETED player picks 1 of the revealed cards (targets[1..]);
    // their pick is moved to targets[1] and the link is marked decided (opt).
    if (spec.usual && link.script.opt === undefined) {
      const revealed = (link.script.targets ?? []).slice(1);
      const target = Number(link.script.targets?.[0] ?? "-1");
      if (revealed.length === 0) {
        // nothing was revealed (deck emptied) — mark decided and resolve as a no-op
        this.state = M.replace(this.state, {
          chain: this.state.chain.map((l, i) => (i === idx && l.script ? { ...l, script: { ...l.script, opt: true } } : l)),
        });
        return false;
      }
      this.pendingResolve = { player: target, effectId: eid, linkIdx: idx, mode: "choose", usualPick: true,
        options: revealed.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "deck" })),
        prompt: `The Usual? — choose 1 revealed card for your hand (the rest go to player ${ctrl})` };
      return true;
    }
    // Breast Expansion: at step 1, the controller chooses the draw mode (-> targets[0]):
    // "fill" draws until 5 in hand, "two" draws 2.
    if (spec.breastExpansion && (link.step ?? 0) === 1 && !(link.script.targets?.length)) {
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", options: [
        { value: "fill", cardId: null, zone: "", label: "Draw until you have 5 cards in hand" },
        { value: "two", cardId: null, zone: "", label: "Draw 2 cards" },
      ], prompt: "Breast Expansion — choose how to draw" };
      return true;
    }
    // Call Slut: the controller picks 1 board/hand card that completes a Special Meld with
    // the opponent's discarded card (targets[0]) + this card. Only completers are offered.
    if (spec.callSlut && (link.script.targets?.length ?? 0) === 1) {
      const discarded = link.script.targets![0]!;
      const self = link.script.self;
      const me = this.state.players.find((p) => p.pid === ctrl);
      const dv = M.valueOf(this.state, discarded);
      const completers = [...(me?.board ?? []), ...(me?.hand ?? [])].filter((c) =>
        c !== self && c !== discarded && (me!.board.includes(c) ? !this.state.instances[c]?.faceDown : true) &&
        M.meldKind([dv, M.valueOf(this.state, self), M.valueOf(this.state, c)]) !== null);
      if (completers.length === 0) return false; // nothing completes the meld -> resolve (no meld)
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", append: true,
        options: completers.map((c) => ({ value: c, cardId: this.state.instances[c]?.cardId ?? null, zone: me!.board.includes(c) ? "board" : "hand" })),
        prompt: "Call Slut — pick a card to complete the Special Meld" };
      return true;
    }
    // Futuristic Player: at step 0 the controller looks at the top 3 of the deck
    // (private — only their own view shows the options) and adds 1 to hand (-> targets[0]).
    if (spec.peekTop && (link.step ?? 0) === 0 && !(link.script.targets?.length)) {
      const top = this.state.mainDeck.slice(0, 3);
      if (top.length === 0) return false; // empty deck -> no add
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose",
        options: top.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "deck" })),
        prompt: "Futuristic Player — add 1 of the top 3 cards to your hand" };
      return true;
    }
    // Haitei Raoyue: optionally meld the drawn card (targets[0]) with 2 cards from your
    // board or the discard top (a guided 2-pick — only cards that can complete a valid
    // meld with the drawn one are offered). Picks append to targets[1..2].
    if (spec.haitei) {
      const drawn = link.script.targets?.[0];
      const picks = (link.script.targets ?? []).slice(1);
      if (drawn === undefined || picks.length >= 2) return false; // resolve -> script melds
      const me = this.state.players.find((p) => p.pid === ctrl);
      const pool = [
        ...(me?.board ?? []).filter((b) => !this.state.instances[b]?.faceDown && this.state.instances[b]?.cardId !== null),
        ...(this.state.discard[0] ? [this.state.discard[0]!] : []),
      ];
      const v = (iid: string) => M.valueOf(this.state, iid);
      const valid = pool.filter((c) => {
        if (picks.includes(c)) return false;
        if (picks.length === 1) return M.meldKind([v(drawn), v(picks[0]!), v(c)]) !== null;
        return pool.some((d) => d !== c && M.meldKind([v(drawn), v(c), v(d)]) !== null);
      });
      if (valid.length === 0) return false; // no (further) valid material -> resolve (no meld unless 2 already picked)
      if (picks.length === 0 && link.script.opt === undefined) {
        this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "opt", options: [],
          prompt: `Haitei Raoyue — make a Special Meld with ${this.state.instances[drawn]?.cardId || drawn}?` };
        return true;
      }
      if (link.script.opt === false) return false; // declined the optional meld
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", append: true,
        options: valid.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: this.zoneOf(iid) })),
        prompt: `Haitei Raoyue — pick a card to meld with ${this.state.instances[drawn]?.cardId || drawn}` };
      return true;
    }
    // Secret Rumors: the TARGET (targets[0]) blindly takes one of the 2 placed
    // face-down cards (targets[1..2]). Options are rendered face-down (cardId null);
    // the pick appends to targets[3] for the script (the move + flip scheduling).
    if (spec.secretMove && (link.script.targets?.length ?? 0) === 3) {
      const t = link.script.targets!;
      const target = Number(t[0]);
      const avail = [t[1]!, t[2]!].filter((iid) => this.state.players.some((p) => p.board.includes(iid)));
      if (avail.length === 0) return false; // both placed cards already left play -> resolve as a no-op
      this.pendingResolve = { player: target, effectId: eid, linkIdx: idx, mode: "choose", append: true,
        options: avail.map((iid) => ({ value: iid, cardId: null, zone: "board" })), // face-down: identity hidden
        prompt: "Secret Rumors — take one of these face-down cards (you cannot look at it)" };
      return true;
    }
    // TSUOM: each opponent, anticlockwise from the controller, chooses 1 card to
    // discard from their hand (hand-pick UI; empty hands are skipped). A finished
    // pass marks the link (script.opt) so it isn't restarted.
    if (spec.tsuom && link.script.opt === undefined) {
      if (!this.pendingTsuom || this.pendingTsuom.linkIdx !== idx) {
        const seating = this.state.seating.length ? [...this.state.seating] : this.state.players.map((p) => p.pid);
        const queue = seatOrder(seating, ctrl).filter(
          (pid) => pid !== ctrl && !(this.state.players.find((p) => p.pid === pid)?.eliminated ?? true),
        );
        this.pendingTsuom = { linkIdx: idx, queue };
      }
      const pt = this.pendingTsuom;
      while (pt.queue.length > 0) {
        const who = pt.queue[0]!;
        const hand = choosableHand(this.state, this.state.players.find((p) => p.pid === who)?.hand ?? []);
        if (hand.length === 0) { pt.queue.shift(); continue; } // only Bricks left -> nothing to discard
        this.pendingResolve = { player: who, effectId: eid, linkIdx: idx, mode: "choose", handPick: "discard",
          options: hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
          prompt: "TSUOM — discard 1 card from your hand" };
        return true;
      }
      this.finishTsuom(idx);
      return false;
    }
    // Beautification Council (MJG-C12): EVERY player (anticlockwise from the controller)
    // discards floor(hand/2) cards of their own choice.
    if (spec.halfDiscard && link.script.opt === undefined) {
      return this.promptHalfDiscard(idx, eid, ctrl, 1, "Beautification Council");
    }
    // Treasurer (MJG-C17): only on a revealed-VALUE sum of 7 — players with MORE THAN 7
    // cards in hand discard half. (6/8 -> add to hand, else nothing: handled by the script.)
    if (spec.treasurerDiscard && link.script.opt === undefined) {
      const t = link.script.targets ?? [];
      const v0 = M.valueOf(this.state, t[0] ?? ""), v1 = M.valueOf(this.state, t[1] ?? "");
      const sum = t.length >= 2 && v0 !== null && v1 !== null ? v0 + v1 : -1;
      if (sum !== 7) { this.finishHalfDiscard(idx); return false; } // mark done -> the script runs (add/shuffle)
      return this.promptHalfDiscard(idx, eid, ctrl, 7, "Treasurer");
    }
    // Target Ron: the controller, then the target, each pick one of their own
    // melds to discard — indexes append to targets ("-1" auto-fills when a side
    // has no meld, so the other side still discards theirs).
    if (spec.meldDiscard) {
      const t = link.script.targets ?? [];
      if (t.length < 3) {
        const who = t.length === 1 ? ctrl : Number(t[0]);
        const melds = this.state.players.find((p) => p.pid === who)?.meldZone ?? [];
        if (melds.length === 0) {
          this.state = M.replace(this.state, {
            chain: this.state.chain.map((l, i) => (i === idx && l.script ? { ...l, script: { ...l.script, targets: [...t, "-1"] } } : l)),
          });
          return this.maybePromptResolveChoice(); // continue to the next pick / resolution
        }
        this.pendingResolve = { player: who, effectId: eid, linkIdx: idx, mode: "choose", append: true,
          options: melds.map((m, i) => ({ value: String(i), cardId: null, zone: "", label: `Meld #${i + 1} — ${m.kind}${m.kan ? " (KAN)" : ""}` })),
          prompt: "Target Ron — choose one of your melds to discard" };
        return true;
      }
    }
    // LTG (Hanana): the targeted opponent (targets[0]) chooses one of their own board
    // cards to discard; the pick appends to targets ("-1" if their board is empty, so the
    // script still Special Summons). Once picked, the script discards it + SS this card.
    if (spec.targetBoardDiscard) {
      const t = link.script.targets ?? [];
      if (t.length < 2) {
        const opp = Number(t[0]);
        const board = this.state.players.find((p) => p.pid === opp)?.board ?? [];
        if (board.length === 0) {
          this.state = M.replace(this.state, {
            chain: this.state.chain.map((l, i) => (i === idx && l.script ? { ...l, script: { ...l.script, targets: [...t, "-1"] } } : l)),
          });
          return this.maybePromptResolveChoice(); // proceed straight to the Special Summon
        }
        this.pendingResolve = { player: opp, effectId: eid, linkIdx: idx, mode: "choose", append: true,
          options: board.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "board" })),
          prompt: "LTG — choose a card on your board to discard" };
        return true;
      }
    }
    // Solem (No): at step 0 the controller discards one of their melds (the cost). The
    // chosen meld index appends to targets[0] for the step-0 script ("-1" if none).
    if (spec.ownMeldDiscard && (link.step ?? 0) === 0 && (link.script.targets ?? []).length === 0) {
      const melds = this.state.players.find((p) => p.pid === ctrl)?.meldZone ?? [];
      if (melds.length === 0) {
        this.state = M.replace(this.state, {
          chain: this.state.chain.map((l, i) => (i === idx && l.script ? { ...l, script: { ...l.script, targets: ["-1"] } } : l)),
        });
        return this.maybePromptResolveChoice();
      }
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", append: true,
        options: melds.map((m, i) => ({ value: String(i), cardId: null, zone: "", label: `Meld #${i + 1} — ${m.kind}${m.kan ? " (KAN)" : ""}` })),
        prompt: "Solem — discard one of your melds (cost)" };
      return true;
    }
    // Pon Yeehaw-style number pick: the controller chooses a number (e.g. "any ℕ")
    // which is written into the link's targets for the script to read.
    if (spec.pickValue && (link.step ?? 0) === 0 && (link.script.targets?.length ?? 0) === 0) {
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "number", options: [],
        min: spec.pickValue.min, max: spec.pickValue.max, prompt: spec.pickValue.prompt, toTargets: true };
      return true;
    }
    // Watson-style value guess: pick a random card from the targeted opponent's hand
    // (kept hidden in pendingGuess), have the controller guess its VALUE, and — if it's
    // a star card — have its owner choose the value. Writes the subject into targets[0]
    // only when the guess is correct, so the script banishes it (+ draws).
    if (spec.guess) {
      const pg = this.pendingGuess;
      if (!pg || pg.linkIdx !== idx) {
        const target = Number(link.script.targets?.[0] ?? "-1");
        const tp = this.state.players.find((p) => p.pid === target && !p.eliminated);
        const hand = tp?.hand ?? [];
        if (!tp || hand.length === 0) {
          this.state = M.replace(this.state, { log: [...this.state.log, `player ${ctrl}'s Watson: player ${target} has no cards`] });
          this.finishGuess(idx, null);
          return false; // no card -> no effect
        }
        const r = nextInt(this.state.rngState, hand.length);
        this.state = M.replace(this.state, { rngState: r.state });
        this.pendingGuess = { linkIdx: idx, controller: ctrl, target, subject: hand[r.value]! };
        this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "number", options: [], min: 1, max: 9, prompt: `Guess the VALUE (1-9) of a random card in player ${target}'s hand` };
        return true;
      }
      if (pg.guess === undefined) return true; // waiting on the guess prompt
      const v = M.valueOf(this.state, pg.subject);
      if (v === null && pg.starValue === undefined) {
        // star (☆) card: its owner decides the value for this resolution — they see
        // the guess and choose to match it (banish) or differ (survive).
        this.pendingResolve = { player: pg.target, effectId: eid, linkIdx: idx, mode: "number", options: [], min: 1, max: 9, prompt: `Player ${pg.controller} guessed VALUE ${pg.guess} for your ☆ card — set its value (1-9): match to be banished, differ to survive` };
        return true;
      }
      const actual = v === null ? pg.starValue! : v;
      const correct = pg.guess === actual;
      // the picked card and the guess are public: record them in the log
      const cardId = this.state.instances[pg.subject]?.cardId || pg.subject;
      this.state = M.replace(this.state, {
        log: [...this.state.log, `player ${pg.controller} guessed VALUE ${pg.guess} for player ${pg.target}'s ${cardId} (value ${actual}) — ${correct ? "correct: banished + draw 1" : "wrong"}`],
      });
      this.finishGuess(idx, correct ? pg.subject : null);
      return false;
    }
    // reorder the top N of the deck: the controller sees the top N (private — viewFor
    // gates by player) and submits the FULL order in one go (the client stages it).
    if (spec.order) {
      const n = Math.min(spec.order, this.state.mainDeck.length);
      const chosen = link.script.targets ?? [];
      if (n === 0 || chosen.length >= n) return false; // nothing to order, or already submitted -> resolve
      const options = this.state.mainDeck.slice(0, n).map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "deck" }));
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "order", options, prompt: "Reorder the top of the deck" };
      return true;
    }
    // Ashes: the controller orders their WHOLE HAND — the submitted order (written into
    // the link's targets) becomes the order the script discards it in.
    if (spec.orderHand) {
      const hand = this.state.players.find((p) => p.pid === ctrl)?.hand ?? [];
      const chosen = link.script.targets ?? [];
      if (hand.length <= 1 || chosen.length > 0) return false; // nothing to order, or already submitted -> resolve
      const options = hand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" }));
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "order", options, prompt: spec.orderHand };
      return true;
    }
    // Gweilo "Frustrated?": the controller looks at the TARGETED player's hand
    // (revealed to the controller only — the choice payload goes to them alone)
    // and picks 1 card to take. The pick APPENDS after the seat target.
    if (spec.theirHand && (link.script.targets?.length ?? 0) === 1) {
      const target = Number(link.script.targets![0]);
      const theirHand = this.state.players.find((p) => p.pid === target)?.hand ?? [];
      if (theirHand.length === 0) return false; // nothing to look at -> resolve as a no-op
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", append: true,
        options: theirHand.map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" })),
        prompt: `Player ${target}'s hand — add 1 card to your hand` };
      return true;
    }
    // step 1: the mandatory "choose" (skip if already chosen, or no candidates).
    if (spec.choose && !(link.script.targets && link.script.targets.length > 0)) {
      let options: { value: string; cardId: string | null; zone: string; label?: string }[] = [];
      if (spec.choose === "player")
        options = this.state.players.filter((p) => !p.eliminated).map((p) => ({ value: String(p.pid), cardId: null, zone: "", label: `Player ${p.pid}` }));
      else if (spec.choose === "discard")
        options = this.state.discard
          .filter((iid) => !spec.chooseFilter || spec.chooseFilter(this.state, iid, ctrl, link.script!.self))
          .map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "discard" }));
      else if (spec.choose === "hand") {
        // a card from the controller's OWN hand — rendered with the hand-click UI. A Brick ([B])
        // is not a choosable discard/banish target (only random effects may hit it -> revealed).
        const noBrick = (spec.chooseLabel ?? "discard") === "discard" || spec.chooseLabel === "banish";
        options = (this.state.players.find((p) => p.pid === ctrl)?.hand ?? [])
          .filter((iid) => (!noBrick || !M.isBrick(this.state.instances[iid]?.cardId)) && (!spec.chooseFilter || spec.chooseFilter(this.state, iid, ctrl, link.script!.self)))
          .map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "hand" }));
      }
      else if (spec.choose === "ownOtherBoard")
        // a face-up character the controller controls, other than the source card
        options = (this.state.players.find((p) => p.pid === ctrl)?.board ?? [])
          .filter((iid) => iid !== link.script!.self && !this.state.instances[iid]?.faceDown)
          .filter((iid) => !spec.chooseFilter || spec.chooseFilter(this.state, iid, ctrl, link.script!.self))
          .map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "board" }));
      else if (spec.choose === "deck")
        // a SEARCH: the matching deck cards, shown to the chooser only (the
        // choice payload is seat-gated); the script shuffles afterwards
        options = this.state.mainDeck
          .filter((iid) => !spec.chooseFilter || spec.chooseFilter(this.state, iid, ctrl, link.script!.self))
          .map((iid) => ({ value: iid, cardId: this.state.instances[iid]?.cardId ?? null, zone: "deck" }));
      if (options.length > 0) {
        this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "choose", options,
          ...(spec.choosePrompt ? { prompt: spec.choosePrompt } : {}),
          ...(spec.choose === "hand" ? { handPick: spec.chooseLabel ?? "discard" } : {}) };
        return true;
      }
      // a deck SEARCH that found nothing still resolves — the player is told
      // (publicly logged; the script's shuffle still happens)
      if (spec.choose === "deck") {
        this.state = M.replace(this.state, {
          log: [...this.state.log, `player ${ctrl} searches the deck — nothing found`],
        });
      }
    }
    // step 2: the "yes/no" decision (undefined = not yet decided). By default the
    // controller answers; `optBy: "target"` lets the targeted player answer (Sara).
    // We Gottem: reveal the TARGETED player's hand to the controller as a confirm-only
    // popup BEFORE the grabs resolve (the ack answer writes opt and resolution proceeds).
    if (spec.revealTargetHand && link.script.opt === undefined) {
      const target = Number(link.script.targets?.[0] ?? "-1");
      // unlike Collusion this reveal is PUBLIC: every player sees the hand, and the
      // cards hit the log (with values) at reveal time, not after the confirm
      for (const p of this.state.players)
        if (p.pid !== target) this.state = applyIntent(this.state, { kind: "revealHandTo", owner: target, viewer: p.pid }).state;
      const hand = this.state.players.find((p) => p.pid === target)?.hand ?? [];
      this.state = applyIntent(this.state, { kind: "reveal", player: target, iids: [...hand] }).state;
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "opt", options: [],
        prompt: "Their hand is revealed — take all [Cunny] and [Shota] cards", revealOwner: target, ack: true };
      return true;
    }
    // Collusion stage 2: the target AGREED — reveal their hand to the activator and
    // gate the draws behind the activator's confirm (the popup shows the hand PRE-draw).
    if (spec.optShowsHand && link.script.opt === true && this.colludeAcked !== idx) {
      const target = Number(link.script.targets?.[0] ?? "-1");
      this.state = applyIntent(this.state, { kind: "revealHandTo", owner: target, viewer: ctrl }).state;
      this.colludeAcked = idx;
      this.pendingResolve = { player: ctrl, effectId: eid, linkIdx: idx, mode: "opt", options: [],
        prompt: "They showed their hand back — confirm to draw 3", revealOwner: target, ack: true };
      return true;
    }
    if (spec.optionalPrompt && link.script.opt === undefined) {
      const optPlayer = spec.optBy === "target" ? Number(link.script.targets?.[0] ?? "-1") : ctrl;
      this.pendingResolve = { player: optPlayer, effectId: eid, linkIdx: idx, mode: "opt", options: [], prompt: spec.optionalPrompt, ...(spec.optShowsHand ? { revealOwner: ctrl } : {}) };
      return true;
    }
    return false;
  }

  /** Answer an optional-trigger prompt: use it (with a chosen target) or skip. */
  choose(seat: Seat, c: Choice): ApplyResult {
    // Geass: the controller answers prompts directed at the TARGET; the target's own
    // inputs are blocked for the controlled turn.
    {
      const ctl = this.geassCtl();
      if (ctl && seat === ctl.tgt) return { ok: false, error: `your turn is controlled by player ${ctl.by} (Geass)` };
      if (ctl && seat === ctl.by && (this.pendingResolve?.player === ctl.tgt || this.pendingChoice?.player === ctl.tgt)) seat = ctl.tgt;
    }
    // "Ya Boy" Fortune Teller: answer the pre-draw scry, then resume the turn draw.
    if (this.pendingFortune && this.pendingResolve?.effectId === "MJG-M20:top") {
      const pr = this.pendingResolve;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      this.pendingFortune = null;
      this.pendingResolve = null;
      if (c.use && this.state.mainDeck.length > 0) {
        const [top, ...rest] = this.state.mainDeck;
        this.state = M.replace(this.state, { mainDeck: [...rest, top!],
          log: [...this.state.log, `player ${seat} places the top card on the bottom of the deck (Fortune Teller)`] });
      }
      this.doTurnDraw();
      return this.settle();
    }
    // Mass discard: the chooser picked which of their cards falls next.
    if (this.pendingResolve?.massPick && this.pendingResolve.linkIdx === -1) {
      const pr = this.pendingResolve;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "pick a card to discard" };
      const g = this.state.pendingEffectDiscards[0];
      this.pendingResolve = null;
      if (g) {
        const rest = g.iids.filter((x) => x !== c.target);
        this.state = M.replace(this.state, {
          pendingEffectDiscards: rest.length
            ? [{ ...g, iids: rest }, ...this.state.pendingEffectDiscards.slice(1)]
            : this.state.pendingEffectDiscards.slice(1),
        });
        this.state = applyIntent(this.state, { kind: "discard", iid: c.target }, g.by, g.source).state;
        this.massWindow = { by: g.by };
        this.passed.clear();
      }
      return this.settle();
    }
    // Explosive Aria: the owner clicked a spot on a board — record "seat:x:y:page".
    if (this.pendingResolve?.placeCard && this.pendingResolve.linkIdx >= 0) {
      const pr = this.pendingResolve;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      const place = c.place;
      if (!place) return { ok: false, error: "click a spot on a board" };
      const tp = this.state.players.find((p) => p.pid === place.seat && !p.eliminated);
      if (!tp) return { ok: false, error: "no such board" };
      const page = Math.max(0, Math.min(Math.floor(place.page) || 0, tp.boardPages - 1));
      const x = Math.max(0, Math.min(Math.round(place.x), M.BOARD_GEOM.maxX));
      const y = Math.max(0, Math.min(Math.round(place.y), M.BOARD_GEOM.maxY));
      const li = pr.linkIdx, placeStr = `${place.seat}:${x}:${y}:${page}`;
      this.state = M.replace(this.state, {
        chain: this.state.chain.map((l, i) => (i === li && l.script ? { ...l, script: { ...l.script, targets: [...(l.script.targets ?? []), placeStr] } } : l)),
        log: [...this.state.log, `player ${seat} places ${this.state.instances[pr.placeCard!]?.cardId ?? "a card"} onto player ${place.seat}'s board (Explosive Aria)`],
      });
      this.pendingResolve = null;
      return this.settle();
    }
    // CEOofLuckshitting "Minimum Wage": the giver hands a chosen card to the recipient.
    if (this.pendingWage && this.pendingResolve && this.pendingResolve.effectId === "MJG-M05:bottom") {
      const pr = this.pendingResolve, w = this.pendingWage;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "give a card from your hand" };
      this.pendingResolve = null;
      this.state = applyIntent(this.state, { kind: "moveToHand", iid: c.target, player: w.recipient }).state;
      if (w.queue[0]) w.queue[0].remaining -= 1;
      return this.settle();
    }
    // Blood Sprout "Tuorps": the active player discards a chosen card.
    if (this.pendingTuorps && this.pendingResolve && this.pendingResolve.effectId === "MJG-410:bottom") {
      const pr = this.pendingResolve, t = this.pendingTuorps;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "discard a card from your hand" };
      this.pendingResolve = null;
      this.state = applyIntent(this.state, { kind: "discard", iid: c.target }).state;
      t.remaining -= 1;
      return this.settle();
    }
    // Cum Chalice "Gate of Babyron": the just-summoned card's attack target. Declaring the
    // battle resolves it through the normal flow; the rampage resumes (next summon) afterwards.
    if (this.pendingBabylon && this.pendingResolve && this.pendingResolve.effectId === "MJG-C26:bottom" && this.pendingResolve.linkIdx === -1) {
      const pr = this.pendingResolve, b = this.pendingBabylon;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "pick an attack target" };
      const attacker = b.attacker!;
      this.pendingResolve = null;
      b.stage = "summon";
      b.attacker = undefined;
      this.reduce({ type: M.ActionType.DECLARE_BATTLE, attackerId: attacker, targetId: c.target });
      return this.settle();
    }
    // Chocolate Cup "Mana Extraction": answer the optional attach-the-loser prompt.
    if (this.manaPending && this.pendingResolve && this.pendingResolve.effectId === "MJG-C25:bottom") {
      const pr = this.pendingResolve, mp = this.manaPending;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      this.pendingResolve = null;
      this.manaPending = null;
      if (c.use) {
        // attach the loser as an overlay (from the board) and remove it from the discard window
        this.state = applyIntent(this.state, { kind: "attachOverlay", host: mp.host, card: mp.loser, from: "board" }).state;
        this.state = M.replace(this.state, { pendingDiscards: this.state.pendingDiscards.filter((d) => d.iid !== mp.loser) });
      }
      return this.settle();
    }
    // a LIVE! placement: the owner picked the character Spinzaku overlays on top of.
    if (this.pendingLive && this.pendingResolve && this.pendingResolve.linkIdx === -1) {
      const pr = this.pendingResolve, pl = this.pendingLive;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
      this.pendingLive = null;
      this.pendingResolve = null;
      this.state = M.liveCover(this.state, pl.iid, c.target);
      return this.settle();
    }
    // a Free-mode deck search: take the pick to hand + shuffle, or cancel (use:false).
    if (this.pendingFreeSearch && this.pendingResolve && this.pendingResolve.linkIdx === -1) {
      const pr = this.pendingResolve, fs = this.pendingFreeSearch;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      this.pendingFreeSearch = null;
      this.pendingResolve = null;
      if (!c.use) return { ok: true }; // cancelled — deck untouched
      if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
      const rest = (fs.deck === "faith" ? this.state.faithDeck : this.state.mainDeck).filter((x) => x !== c.target);
      const sh = shuffleWith(this.state.rngState, rest); // searched -> shuffle what remains
      this.state = M.replace(this.state, {
        rngState: sh.state,
        ...(fs.deck === "faith" ? { faithDeck: sh.value } : { mainDeck: sh.value }),
        players: this.state.players.map((p) => (p.pid === seat ? { ...p, hand: [...p.hand, c.target!] } : p)),
        log: [...this.state.log, `[free] player ${seat} searches the ${fs.deck} deck and takes ${this.state.instances[c.target]?.cardId || c.target}`],
      });
      return { ok: true };
    }
    // a declared KAN's Rinshan Faith-deck pick: resolve the KAN with the chosen card.
    if (this.pendingKan && this.pendingResolve && this.pendingResolve.linkIdx === -1) {
      const pr = this.pendingResolve;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
      const pk = this.pendingKan;
      this.pendingKan = null;
      this.pendingResolve = null;
      try {
        this.reduce({ type: M.ActionType.RESOLVE_KAN, player: seat, meldIndex: pk.meldIndex, kanMaterial: pk.material, faithSearch: c.target });
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      return this.settle();
    }
    // MARY "Literary Club": pay the declared attack's discard cost, then issue the attack.
    if (this.pendingAttack && this.pendingResolve && this.pendingResolve.effectId === "MJG-C10:top") {
      const pa = this.pendingAttack, pr = this.pendingResolve;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "discard 1 card to attack" };
      this.state = applyIntent(this.state, { kind: "discard", iid: c.target }).state;
      this.pendingResolve = null;
      this.pendingAttack = null;
      this.reduce({ type: M.ActionType.DECLARE_BATTLE, attackerId: pa.attacker, targetId: pa.target });
      return this.settle();
    }
    // an activation-time decision (PSCT pre-colon condition): route into the pending
    // activation, then continue/announce. Marked by linkIdx === -1 (not yet chained).
    if (this.pendingResolve && this.pendingActivation && this.pendingResolve.linkIdx === -1) {
      const pr = this.pendingResolve, pa = this.pendingActivation;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      if (pr.mode === "number") {
        const v = c.value, min = pr.min ?? 1, max = pr.max ?? 9;
        if (v === undefined || !Number.isInteger(v) || v < min || v > max) return { ok: false, error: `enter a number ${min}-${max}` };
        if (pa.guess === undefined) pa.guess = v; else pa.starValue = v;
      } else if (pr.mode === "opt") {
        pa.opt = c.use;
      } else if (pr.mode === "choose") {
        // a discard-cost pick (one hand card at a time)
        if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
        (pa.cost ??= []).push(c.target);
      } else {
        return { ok: false, error: "unexpected activation choice" };
      }
      this.pendingResolve = null;
      if (this.advanceActivation()) return { ok: true };
      return this.settle();
    }
    // a decision made as the top link resolves: write the pick into that link.
    if (this.pendingResolve) {
      const pr = this.pendingResolve;
      if (pr.player !== seat) return { ok: false, error: "no choice expected from this seat" };
      // Belly Dance sub-choice (which Active, one of its targets, or a hand meld)
      if (this.pendingBelly && this.pendingBelly.linkIdx === pr.linkIdx) {
        const bell = this.pendingBelly;
        if (pr.mode === "handMeld") {
          // copied a >dama-style Active: special-meld 3 chosen hand cards, then no-op
          try {
            this.state = M.meldHandCards(this.state, bell.controller, c.materials ?? []);
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
          if (bell.attachTo) this.pendingClassAttach = { host: bell.attachTo, card: bell.char }; // attach after — fizzles if the subject was melded
          this.transformBelly(pr.linkIdx, null);
          this.pendingBelly = null;
          this.pendingResolve = null;
          return this.settle();
        }
        if (bell.needSubject) {
          // Class Card: the revealed hand card whose Active is copied (and then attached)
          if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
          bell.char = c.target;
          bell.needSubject = false;
          this.state = M.replace(this.state, { log: [...this.state.log, `player ${bell.controller} reveals ${this.state.instances[bell.char]?.cardId ?? bell.char}`] }); // "Reveal a card in your hand"
        } else if (bell.role === undefined) {
          if (c.target !== "top" && c.target !== "bottom") return { ok: false, error: "pick an Active" };
          bell.role = c.target;
        } else {
          if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid target" };
          bell.targets.push(c.target);
        }
        this.pendingResolve = null;
        return this.settle();
      }
      // G***u parity-game sub-answers (pick / guess / discard / repeat)
      if (this.pendingParity && this.pendingParity.linkIdx === pr.linkIdx) {
        const pp = this.pendingParity;
        if (pp.stage === "pick") {
          if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
          pp.subject = c.target; // hidden from the guesser
          pp.stage = "guess";
        } else if (pp.stage === "guess") {
          if (c.target !== "odd" && c.target !== "even") return { ok: false, error: "guess odd or even" };
          const v = M.valueOf(this.state, pp.subject!);
          const isEven = v === null || v % 2 === 0; // ☆ counts as even
          const correct = (c.target === "even") === isEven;
          // the chosen card is REVEALED by the guess — it's public information now
          const cardId = this.state.instances[pp.subject!]?.cardId || pp.subject!;
          this.state = M.replace(this.state, {
            log: [...this.state.log, `player ${pp.target} guessed ${c.target} — the chosen card was ${cardId} (VALUE ${v ?? "☆"}): ${correct ? "correct" : "wrong"}`],
          });
          pp.stage = correct ? "repeat" : "discard";
        } else if (pp.stage === "discard") {
          if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
          // applyIntent so the discard emits its "discarded" event (e.g. Copestream)
          this.state = applyIntent(this.state, { kind: "discard", iid: c.target }).state;
          pp.stage = "repeat";
        } else {
          // stage "repeat" (an opt prompt): continue or stop
          if (c.use) { pp.round += 1; pp.stage = "pick"; }
          else this.finishParity(pr.linkIdx);
        }
        this.pendingResolve = null;
        return this.settle();
      }
      // TSUOM sub-answers: the prompted opponent's discard pick
      if (this.pendingTsuom && this.pendingTsuom.linkIdx === pr.linkIdx) {
        if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
        // applyIntent so the discard emits its "discarded" event (e.g. Copestream)
        this.state = applyIntent(this.state, { kind: "discard", iid: c.target }).state;
        this.pendingTsuom.queue.shift();
        this.pendingResolve = null;
        return this.settle();
      }
      // Beautification Council sub-answers: the prompted player's discard pick
      if (this.pendingHalfDiscard && this.pendingHalfDiscard.linkIdx === pr.linkIdx) {
        if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
        this.state = applyIntent(this.state, { kind: "discard", iid: c.target }).state;
        const head = this.pendingHalfDiscard.queue[0];
        if (head) { head.remaining -= 1; if (head.remaining <= 0) this.pendingHalfDiscard.queue.shift(); }
        this.pendingResolve = null;
        return this.settle();
      }
      // The Usual?: the target's pick — reorder targets to [seat, pick, ...rest]
      if (pr.usualPick) {
        if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
        const t = this.state.chain[pr.linkIdx]?.script?.targets ?? [];
        const rest = t.slice(1).filter((x) => x !== c.target);
        this.state = M.replace(this.state, {
          chain: this.state.chain.map((l, i) =>
            i === pr.linkIdx && l.script ? { ...l, script: { ...l.script, targets: [t[0]!, c.target!, ...rest], opt: true } } : l,
          ),
        });
        this.pendingResolve = null;
        return this.settle();
      }
      // Ravioli "succ" sub-answers (repeat? / pick the next character)
      if (this.pendingSucc && this.pendingSucc.linkIdx === pr.linkIdx) {
        const ps = this.pendingSucc;
        if (ps.stage === "repeat") {
          if (c.use) ps.stage = "pick";
          else this.finishSucc(pr.linkIdx);
        } else {
          if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
          ps.pending = c.target; // attached on the next resolve pass
        }
        this.pendingResolve = null;
        return this.settle();
      }
      // NEET "Simp" sub-answers (pick a deck card to give / give another?)
      if (this.pendingSimp && this.pendingSimp.linkIdx === pr.linkIdx) {
        const ps = this.pendingSimp;
        if (ps.stage === "pick") {
          if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
          const cur = this.state.chain[pr.linkIdx]?.script?.targets ?? [];
          this.state = M.replace(this.state, {
            chain: this.state.chain.map((l, i) => (i === pr.linkIdx && l.script ? { ...l, script: { ...l.script, targets: [...cur, c.target!] } } : l)),
          });
          ps.remaining = ps.remaining.filter((x) => x !== c.target);
          ps.stage = "more";
        } else if (c.use) {
          ps.stage = "pick"; // give another
        } else {
          this.finishSimp(pr.linkIdx); // done — at least one was given
        }
        this.pendingResolve = null;
        return this.settle();
      }
      if (pr.mode === "number") {
        // a numeric answer: into the link's targets (toTargets) or the private pendingGuess
        const v = c.value;
        const min = pr.min ?? 1, max = pr.max ?? 9;
        if (v === undefined || !Number.isInteger(v) || v < min || v > max) return { ok: false, error: `enter a number ${min}-${max}` };
        if (pr.toTargets) {
          this.state = M.replace(this.state, {
            chain: this.state.chain.map((l, i) => (i === pr.linkIdx && l.script ? { ...l, script: { ...l.script, targets: [String(v)] } } : l)),
          });
        } else {
          const pg = this.pendingGuess;
          if (pg) { if (pg.guess === undefined) pg.guess = v; else pg.starValue = v; }
        }
        this.pendingResolve = null;
        return this.settle();
      }
      let patch: { targets?: string[]; opt?: boolean };
      if (pr.mode === "opt") {
        patch = { opt: c.use };
      } else if (pr.mode === "order") {
        // an ordering: must be a permutation of the offered candidates. Appends to
        // any already-chosen order (so multi-group orderings accumulate).
        const order = c.order ?? [];
        const vals = pr.options.map((o) => o.value);
        const ok = order.length === vals.length && new Set(order).size === order.length && order.every((x) => vals.includes(x));
        if (!ok) return { ok: false, error: "invalid order" };
        const cur = this.state.chain[pr.linkIdx]?.script?.targets ?? [];
        patch = { targets: [...cur, ...order] };
      } else {
        if (!c.target || !pr.options.some((o) => o.value === c.target)) return { ok: false, error: "invalid choice" };
        // append-style picks (e.g. Gweilo's take) keep the existing targets in front
        const cur = pr.append ? this.state.chain[pr.linkIdx]?.script?.targets ?? [] : [];
        patch = { targets: [...cur, c.target] };
      }
      this.state = M.replace(this.state, {
        chain: this.state.chain.map((l, i) => (i === pr.linkIdx && l.script ? { ...l, script: { ...l.script, ...patch } } : l)),
      });
      this.pendingResolve = null;
      return this.settle();
    }
    const pc = this.pendingChoice;
    if (!pc || pc.player !== seat) return { ok: false, error: "no choice expected from this seat" };
    const t = this.trigQueue[0]!;
    try {
      if (c.use) {
        if (pc.candidates.length > 0) {
          if (!c.target || !pc.candidates.includes(c.target)) return { ok: false, error: "invalid target" };
          if (t.script) t.script = { ...t.script, targets: [c.target] };
        }
        this.trigReady.push(t);
      }
      this.pendingChoice = null;
      this.trigQueue.shift();
      if (this.advanceTriggers() === "await") return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return this.settle();
  }

  /** Strict PSCT: when the top link is mid-resolution (cursor > 0) and the step about
   *  to resolve follows a NON-respondable connector (`and`/`also`/`if you do`), no
   *  window opens — resolve it immediately. Step 0's window is the activation window. */
  private midResolutionNoWindow(): boolean {
    const link = this.state.chain[this.state.chain.length - 1];
    if (!link?.script) return false;
    const cursor = link.step ?? 0;
    if (cursor === 0) return false;
    return getSteps(link.script.cardId, link.script.role)[cursor]?.respondBefore === false;
  }

  /** First seat to prompt: scanning anticlockwise from the TURN player, the first
   *  that isn't the activator, hasn't passed, has toggle != off and a legal response. */
  private nextResponder(): Seat | null {
    const living = this.state.players.filter((pl) => !pl.eliminated).map((pl) => pl.pid);
    if (living.length === 0) return null;
    // Priority starts with whoever just acted (the activator may respond to
    // themselves) and passes anticlockwise; after a resolution windowActivator is
    // cleared, so it anchors at the turn player. Seats that passed / can't respond
    // are skipped; a chain growth clears `passed` so everyone gets another round.
    const anchor = this.state.windowActivator ?? this.state.activePlayer;
    const order = seatOrder(this.state.seating.length ? [...this.state.seating] : living, anchor);
    // Geass: the controller's OWN seat auto-passes for the controlled turn (their
    // perspective is fully the target's, so their own windows can't be answered).
    const ctl = this.geassCtl();
    for (const s of order) {
      if (this.passed.has(s)) continue;
      if (!living.includes(s)) continue;
      if (ctl && s === ctl.by) continue;
      const t = this.toggleOf(s);
      if (t === "off") continue;
      if (!canRespond(this.state, s)) continue; // BOTH require a legal response
      // "auto" only fires when reacting to an OPPONENT's action; "always" fires at
      // every open window (incl. your own action / phase / post-resolution windows).
      if (t === "auto" && !this.reactingToOpponent(s)) continue;
      return s;
    }
    return null;
  }

  /** Is the current open window a reaction to ANOTHER player's action (for `auto`)?
   *  True when responding to someone else's chain link, an opponent's just-announced
   *  summon/battle, or a battle discard the active player caused. Phase-boundary and
   *  post-resolution windows (empty chain, nothing pending) are NOT — only `always`
   *  stops there. */
  private reactingToOpponent(s: Seat): boolean {
    const st = this.state;
    if (st.chain.length > 0) return st.chain[st.chain.length - 1]!.sourcePlayer !== s;
    if (st.phase === M.Phase.ACTION_ANNOUNCED) return st.activePlayer !== s; // opponent's summon/battle declaration
    if (st.pendingDiscards.length > 0) return st.activePlayer !== s; // reacting to the attacker's battle discard
    // a POST-RESOLUTION window right after an OPPONENT's effect finished resolving:
    // end-of-chain reactions (Shoumakyou) live exactly here, so "auto" prompts too.
    if (this.lastResolvedBy !== null && this.lastResolvedBy !== s) return true;
    return false;
  }
}
