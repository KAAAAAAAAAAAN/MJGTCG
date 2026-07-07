/**
 * MJGTCG effect-execution model.
 *
 * A card ability is a SCRIPT: a generator that yields primitive `Intent`s. The
 * interpreter (`runEffect`) applies each intent to the game state and feeds the
 * result back via `.next()`, so scripts never mutate state directly — they read
 * through `ctx.state()` and request changes as data. This keeps effect
 * resolution inside the authoritative engine and replayable.
 *
 * Phase 1a: the minimal primitive set (draw / specialSummon / summonTopOfDeck /
 * discard) used by the first batch of (no-input) cards. Player-input intents
 * (targeting, choices) arrive with the next capability slice; the generator's
 * `.next(result)` channel already accommodates them — the interpreter will then
 * pause instead of running straight to completion.
 */
import { player, replace, valueOf, meldKind, canSpecialSummon, isBrick, isEffectImmune, soaImmune, cannotBeAttacked, matchmakerBonded, meldBoardCards, discardOrRedirect, pizzaHutCode, liveRedirect, mintInstance, cardData, chargePoison, abilityCardIds, assignBoardPos, Phase, type GameState, type ChainLink, type Battle } from "./reducer.js";
import type { Seat } from "./rules.js";
import { getSteps } from "./card-scripts.js";
import { ACTIVATIONS } from "./legal.js";
import { nextInt, shuffleWith } from "./rng.js";

// ---- intents ----------------------------------------------------------------
export type Intent =
  | { kind: "draw"; player: Seat; count: number; deck?: "main" | "faith"; from?: "top" | "bottom" }
  | { kind: "summonTopOfDeck"; controller: Seat } // -> summoned iid | null
  // negated = "negate its effects" (no activations/triggers/auras while in play);
  // linkedBy = the summoner's iid — the card is discarded when that card leaves
  // the controller's board (Shadow Clone)
  | { kind: "specialSummon"; iid: string; controller: Seat; negated?: boolean; linkedBy?: string }
  // search hand -> deck -> discard for the first card with this id and SS it (1 copy)
  | { kind: "summonNamed"; controller: Seat; cardId: string; from: ("hand" | "deck" | "discard")[] }
  | { kind: "summonToken"; controller: Seat; cardId: string } // mint a token (e.g. BIG ICHIHIME) and SS it
  | { kind: "discard"; iid: string } // to the TOP of the discard pile
  | { kind: "discardRandom"; player: Seat; count: number } // discard N random cards from a hand (PRNG)
  | { kind: "banishRandom"; player: Seat; count: number } // banish N random cards from a hand (PRNG)
  | { kind: "discardOneByOne"; iids: string[]; chooser?: Seat } // mass discard: queued as a group; `chooser` picks the order, one window per discard
  | { kind: "redistributeHands"; players: Seat[] } // pool the listed hands, shuffle, re-deal original counts
  | { kind: "shuffleHandIntoDeck"; player: Seat } // shuffle a player's whole hand into the Main deck (PRNG)
  // negate the chain link directly BELOW the resolving link (`self` = the resolving
  // link's source card) -> returns the negated link's source card iid (or null)
  | { kind: "negateBelow"; self: string }
  // Solem vs a SUMMON announcement (no chain link below): negate the announced summon —
  // strips any still-queued on-summon event and returns the summoned iid (else null)
  | { kind: "negateSummon" }
  | { kind: "addCounter"; iid: string; counter: string; amount: number }
  | { kind: "playerCounter"; player: Seat; counter: string; amount: number } // a PLAYER-level counter (Clown)
  | { kind: "setEffectLock"; player: Seat } // Shoumakyou: opponents of `player` can't activate effects this turn
  | { kind: "scheduleHandShuffle"; player: Seat } // Diabolus ex Machina: shuffle `player`'s hand into the deck at end of turn
  | { kind: "winGame"; player: Seat } // Deus ex Machina: `player` wins the game immediately
  // flip face-down. `until` says when it flips back (per-effect schedule):
  //   "startOfNextTurn" (default, Book of Moon): the START of `player`'s next turn;
  //   "endOfThisTurn" (Trap Trick): the END of `player`'s current turn.
  | { kind: "flipDown"; iid: string; player: Seat; until?: "startOfNextTurn" | "endOfThisTurn" }
  | { kind: "flipUp"; iid: string } // flip a face-down board character face-up (any pending unflip just no-ops later)
  | { kind: "setFaceDown"; iid: string; player: Seat } // place a hand card face-down on a board (a "set", not a summon)
  | { kind: "skipTurn"; player: Seat } // that player's next turn never starts (ADVANCE consumes the debt)
  | { kind: "armTurnControl"; player: Seat; by: Seat } // "Geass": `by` controls `player`'s next turn
  | { kind: "scheduleEndTurn"; player: Seat } // "Monopoly": end `player`'s turn once resolution settles
  | { kind: "moveToExtra"; iid: string } // "Upload" (Catbox): place a card in the shared Extra Zone
  // SS `iid` (from hand) onto the board where `onto` sits, tucking `onto` beneath it
  // as an overlay (the board owner controls the summoned card) -> summoned iid | null
  | { kind: "overlaySummon"; iid: string; onto: string }
  | { kind: "moveToBoard"; iid: string; player: Seat } // move a board card (overlays ride along) to another player's board
  // attach a BOARD character (or, with from:"hand", a hand card) beneath `host` as
  // an overlay -> attached iid | null. `returnAtEndOfTurnOf` schedules the overlay
  // back to that player's hand at the end of their turn (Lead Character).
  | { kind: "attachOverlay"; host: string; card: string; from?: "board" | "hand"; returnAtEndOfTurnOf?: Seat }
  // Lead Character: the hand card COVERS the host — it takes the host's board slot as the
  // stack top and the host (plus its materials, flat) tucks beneath it. NOT a summon.
  | { kind: "coverWith"; host: string; card: string; returnAtEndOfTurnOf?: Seat }
  // stun: cannot attack or use ACTIVE effects until the next time `untilEndOfTurnOf` ends their turn
  | { kind: "stun"; iid: string; untilEndOfTurnOf: Seat; nextTurn?: boolean } // nextTurn: lapse at that player's NEXT turn end (skip the current one if it's their turn)
  // Party Hard: every board character moves to a uniformly random living board (PRNG)
  | { kind: "scrambleBoards" }
  | { kind: "revealHandTo"; owner: Seat; viewer: Seat } // `viewer` may see `owner`'s hand (until the turn change)
  | { kind: "endHandReveal"; owner: Seat; viewer: Seat } // the hand goes back to private info (Collusion, once the deal settles)
  // discard a player's completed meld (its cards go to the discard pile); index into meldZone
  | { kind: "discardMeld"; player: Seat; index: number }
  | { kind: "shuffleDeck" } // shuffle the Main deck (PRNG)
  | { kind: "shuffleIntoDeck"; iid: string } // move a card (board/hand/discard) into the Main deck, then shuffle
  | { kind: "scheduleEndTurnDiscard"; iid: string; player: Seat } // discard `iid` at the end of `player`'s turn (Sacred Enjou)
  | { kind: "setUnlimitedSummon"; player: Seat } // all players may Normal Summon any number of times until the end of `player`'s next turn (Ashes)
  | { kind: "scheduleStartTurnSummon"; iid: string; player: Seat } // SS `iid` from the discard at the start of `player`'s next turn (Ashes)
  | { kind: "armPoison"; player: Seat } // arm `player`'s poison to take effect on their next turn (Snake Bite)
  // Matchmaker: bond a+b until the start of `player`'s next turn (can't attack each
  // other; shared discard fate)
  | { kind: "matchmakerBond"; a: string; b: string; player: Seat }
  // Immunize: the card cannot be melded or effect-removed until the START of
  // `player`'s next turn (per-effect schedule)
  | { kind: "grantImmunity"; iid: string; player: Seat }
  | { kind: "reorderTop"; order: string[] } // place these (deck) cards on top of the main deck, in this order
  | { kind: "takeDiscardTop"; player: Seat } // move the current top of the discard pile to a player's hand
  | { kind: "summonRandomFromHand"; player: Seat } // SS a random card from a player's hand to their board
  | { kind: "meldFromDeckTop"; player: Seat; count: number } // reveal top N; special-meld them if valid, else shuffle the deck
  // meld for `player` from specific board materials (across any boards) — they leave
  // play into `player`'s meld zone (SCOR SOM FACKIN MANGANS, Tile Efficiency). Fizzles
  // if invalid. `noFaith` suppresses the default Faith draw.
  | { kind: "meldBoard"; player: Seat; materials: string[]; noFaith?: boolean }
  // negate a PENDING (declared, not-yet-resolved) meld so it never resolves; a negated
  // NORMAL meld is still "used up" (the melder's once-per-turn gate is consumed).
  | { kind: "negateMeld" }
  | { kind: "forcedDiscard"; groups: { player: Seat; iids: string[] }[] } // queue per-owner board discards (one-at-a-time, respondable)
  | { kind: "moveToHand"; iid: string; player: Seat } // move a card to a SPECIFIC player's hand
  | { kind: "preventBattleDiscard"; player: Seat } // cancel this player's pending battle discard(s) ("… instead")
  // effect-driven battle: set up a pending battle that settles when the resolution
  // window closes (beginBattleDiscards). oneSided = the defender "does not fight
  // back" (fOUnD mEeEeee) — it can be discarded but never discards the attacker.
  // -> "attacked" if the battle was set up, null if it was illegal/fizzled.
  | { kind: "effectAttack"; attacker: string; target: string; oneSided?: boolean }
  | { kind: "untap"; iid: string } // "can attack again" / clear tapped
  | { kind: "moveTo"; iid: string; to: "hand" | "banish" | "deckTop" | "deckBottom" | "discardTop" | "discardBottom" }
  | { kind: "reveal"; player: Seat; iids: string[] } // publicly reveal card(s) — logs their identities
  | {
      kind: "statMod";
      iid: string;
      stat: "atk" | "def" | "value";
      op: "add" | "set" | "mul";
      amount: number;
      duration: "endOfTurn" | "persistent";
    };

/** Value the interpreter sends back into the generator after each intent. */
export type IntentResult = string[] | string | null | undefined;

export interface EffectContext {
  readonly controller: Seat; // the player resolving the effect
  readonly self: string; // the source card instance (iid)
  readonly targets: readonly string[]; // targets chosen & locked at activation
  readonly opt: boolean; // an optional ("you can …") sub-effect was accepted at activation
  /** Current state snapshot — call between yields to read fresh state. */
  state(): GameState;
  /** Per-resolution scratchpad, carried across an ability's steps (it persists on
   *  the chain link between step-wise resolutions). Mutating it is the one allowed
   *  exception to "scripts don't mutate" — it is NOT game state. Used e.g. by
   *  FAT-009 to pass the summoned count from the summon step to the draw step. */
  readonly scratch: Record<string, number>;
}

export type EffectScript = (ctx: EffectContext) => Generator<Intent, void, IntentResult>;

/**
 * A single resolution STEP of an ability. PSCT resolves an ability one step at a
 * time; `respondBefore` is the respondability of the connector PRECEDING this step
 * — true after `then`/`;` and `.`/`next` (a response window opens), false after
 * `and`/`and then`/`also`/`if you do` and for step 0 (the activation window already
 * covered it). See `_psct_dump.txt` R14/R27/R33/R36.
 */
export interface Step {
  run: EffectScript;
  respondBefore: boolean;
}
export type StepList = Step[];

// ---- low-level state ops (local; immutable) ---------------------------------
function setPlayer(s: GameState, pid: Seat, changes: Partial<ReturnType<typeof player>>): GameState {
  return replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, ...changes } : p)) });
}
/** Strip an instance from every shared zone and every hand/board (not melds). */
function detach(s: GameState, iid: string): GameState {
  return replace(s, {
    mainDeck: s.mainDeck.filter((x) => x !== iid),
    faithDeck: s.faithDeck.filter((x) => x !== iid),
    discard: s.discard.filter((x) => x !== iid),
    banish: s.banish.filter((x) => x !== iid),
    players: s.players.map((p) => ({
      ...p,
      hand: p.hand.filter((x) => x !== iid),
      board: p.board.filter((x) => x !== iid),
    })),
  });
}
/** Current owner of an instance = the player whose hand/board holds it (FAQ R57). */
function ownerOf(s: GameState, iid: string): Seat | null {
  for (const p of s.players) if (p.board.includes(iid) || p.hand.includes(iid)) return p.pid;
  return null;
}
function placeOnBoard(s: GameState, pid: Seat, iid: string): GameState {
  // every effect SS goes through here -> mark "Special Summoned this turn" (Game Limit)
  const ci = s.instances[iid];
  if (ci) {
    s = replace(s, { instances: { ...s.instances, [iid]: { ...ci, faceDown: false, tapped: false, ssThisTurn: true } } });
  }
  const p = player(s, pid);
  return assignBoardPos(setPlayer(s, pid, { board: [...p.board, iid] }), pid, iid);
}
/** Leaving PLAY (to any non-board zone) clears stat mods and counters
 *  (FAQ R46/R68). Control-change (board->board) keeps them and never calls this. */
function resetOnLeavePlay(s: GameState, iid: string): GameState {
  const ci = s.instances[iid];
  if (!ci) return s;
  // a card leaving play to hand/deck/discard/banish loses all in-play state: mods,
  // counters, battles, and it becomes untapped & face-up (FAQ R46).
  if (ci.mods.length === 0 && Object.keys(ci.counters).length === 0 && ci.battles === 0 && !ci.tapped && !ci.faceDown && !ci.stunned && !ci.ssThisTurn && !ci.effectsNegated && !ci.linkedTo && !ci.protectedFromEffects && !ci.pos) return s;
  return replace(s, { instances: { ...s.instances, [iid]: { ...ci, mods: [], counters: {}, battles: 0, tapped: false, faceDown: false, stunned: false, ssThisTurn: false, effectsNegated: false, linkedTo: undefined, protectedFromEffects: false, pos: undefined } } });
}

// Cards that "cannot be removed from your board by effects" (Mommy Milkers). The
// guard blocks effect-driven removals (discard/moveTo/moveToHand/forcedDiscard)
// while the card is on a board; BATTLE discards bypass it — they resolve in the
// reducer's battle path, not through these intents. Hand/deck copies aren't
// protected (the text protects the board presence only).
const EFFECT_REMOVAL_PROTECTED = new Set(["MJG-32歳"]);
// "Cannot be flipped face-down" (Mommy Milkers ruling) — flipDown no-ops on these.
const CANNOT_FLIP_FACEDOWN = new Set(["MJG-32歳"]);
function protectedOnBoard(s: GameState, iid: string, by?: Seat): boolean {
  const ci = s.instances[iid];
  if (!ci) return false;
  if (immuneFrom(s, iid, by)) return true; // Supermodel (all) / SOA (opponent effects)
  const protectedByAbility = abilityCardIds(s, iid).some((id) => EFFECT_REMOVAL_PROTECTED.has(id));
  if (!protectedByAbility && !ci.protectedFromEffects) return false;
  return s.players.some((p) => p.board.includes(iid));
}
/** Owner (board/hand holder) of a card. */
function ownerSeat(s: GameState, iid: string): Seat | undefined {
  return s.players.find((p) => p.board.includes(iid) || p.hand.includes(iid))?.pid;
}
/** Is card `iid` immune to an effect applied by `by`? Supermodel is immune to ALL
 *  effects; SOA (Temeraire) makes a player's cards immune to OPPONENT effects (`by` is
 *  an opponent of the owner). `by === undefined` => only Supermodel applies. */
function immuneFrom(s: GameState, iid: string, by?: Seat): boolean {
  if (isEffectImmune(s, iid)) return true;
  if (by === undefined) return false;
  const owner = ownerSeat(s, iid);
  return owner !== undefined && owner !== by && soaImmune(s, owner);
}
/** Is PLAYER `pid` immune to an effect applied by `by`? (SOA: opponent effects only.) */
function playerImmune(s: GameState, pid: Seat, by?: Seat): boolean {
  return by !== undefined && by !== pid && soaImmune(s, pid);
}
/** Center Stage T (MJG-C34 on top of the discard pile): no player may Special Summon. */
function ssBlocked(s: GameState): boolean {
  const top = s.discard[0];
  return top !== undefined && s.instances[top]?.cardId === "MJG-C34";
}
function ssBlockedResult(s: GameState): { state: GameState; result: null } {
  return { state: replace(s, { log: [...s.log, "Special Summon prevented (Center Stage T)"] }), result: null };
}
function protectLog(s: GameState, iid: string): GameState {
  return replace(s, { log: [...s.log, `${s.instances[iid]?.cardId ?? iid} cannot be removed from the board by effects`] });
}
function immuneLog(s: GameState, iid: string): GameState {
  return replace(s, { log: [...s.log, `${s.instances[iid]?.cardId ?? iid} is immune to card effects (Supermodel)`] });
}

// ---- intent application -----------------------------------------------------
// `source` = the iid of the card whose effect yielded this intent (runEffect threads it).
// Used by Snake Bite: a self-Special-Summon (Banana, a Faith summon) already charged
// poison at its ACTIVATION, so the SS of the source card itself doesn't charge again.
export function applyIntent(state: GameState, intent: Intent, by?: Seat, source?: string): { state: GameState; result: IntentResult } {
  // "Snake Bite": Special Summoning a card while poisoned is "playing" it — 1 random
  // hand discard per counter (skipped when the summoned card IS the activated source).
  const poisonSS = (s: GameState, controller: Seat, iid: string): GameState =>
    s.poisonActive.includes(controller) && iid !== source ? chargePoison(s, controller, new Set([iid])) : s;
  switch (intent.kind) {
    case "draw": {
      if (playerImmune(state, intent.player, by)) return { state, result: [] }; // SOA: immune to an opponent's draw effect
      let s = state;
      const drawn: string[] = [];
      const deck = intent.deck ?? "main";
      const fromBottom = intent.from === "bottom";
      // Center Stage H (MJG-C32 on top of the discard pile): every draw EFFECT draws exactly 2.
      const dTop = state.discard[0];
      const count = dTop !== undefined && state.instances[dTop]?.cardId === "MJG-C32" ? 2 : intent.count;
      for (let i = 0; i < count; i++) {
        const pile = deck === "main" ? s.mainDeck : s.faithDeck;
        if (pile.length === 0) {
          // drawing from an empty MAIN deck by an EFFECT eliminates the player (RULES
          // sec 11), same as the turn draw. An empty Faith deck is NOT a deckout — it
          // just draws fewer. The session settle loop finalizes any winner set here.
          if (deck === "main" && !player(s, intent.player).eliminated) {
            s = setPlayer(s, intent.player, { eliminated: true, hand: [], board: [], meldZone: [] });
            s = replace(s, { log: [...s.log, `player ${intent.player} drew from the empty deck by an effect -> eliminated (ghost board)`] });
            const living = s.players.filter((p) => !p.eliminated).map((p) => p.pid);
            if (living.length <= 1) s = replace(s, { winner: living[0] ?? null, phase: Phase.GAME_OVER, log: [...s.log, `game over — ${living.length === 1 ? `player ${living[0]} wins (last standing)` : "no players remain"}`] });
          }
          break;
        }
        const card = fromBottom ? pile[pile.length - 1]! : pile[0]!;
        const rest = fromBottom ? pile.slice(0, -1) : pile.slice(1);
        s = deck === "main" ? replace(s, { mainDeck: rest }) : replace(s, { faithDeck: rest });
        const p = player(s, intent.player);
        s = setPlayer(s, intent.player, { hand: [...p.hand, card] });
        // "when you draw this card" triggers fire for Main-deck draws; byEffect
        // marks these as CARD-EFFECT draws (vs the turn draw — a game action)
        if (deck === "main") s = replace(s, { events: [...s.events, { kind: "draw", iid: card, player: intent.player, byEffect: true }] });
        drawn.push(card);
      }
      return { state: s, result: drawn };
    }
    case "summonTopOfDeck": {
      if (ssBlocked(state)) return ssBlockedResult(state); // Center Stage T
      if (state.mainDeck.length === 0) return { state, result: null };
      const iid = state.mainDeck[0]!;
      let s = replace(state, { mainDeck: state.mainDeck.slice(1) });
      s = placeOnBoard(s, intent.controller, iid);
      s = replace(s, { events: [...s.events, { kind: "summon", iid, player: intent.controller, special: true }] }); // "when summoned" triggers fire
      s = poisonSS(s, intent.controller, iid);
      return { state: s, result: iid };
    }
    case "specialSummon": {
      if (ssBlocked(state)) return ssBlockedResult(state); // Center Stage T
      const fromDiscard = state.discard.includes(intent.iid); // for "SS'd from the discard pile" (Rebirth)
      let s = detach(state, intent.iid);
      s = placeOnBoard(s, intent.controller, intent.iid);
      if (intent.negated || intent.linkedBy) {
        const ci = s.instances[intent.iid]!;
        s = replace(s, { instances: { ...s.instances, [intent.iid]: {
          ...ci,
          ...(intent.negated ? { effectsNegated: true } : {}),
          ...(intent.linkedBy ? { linkedTo: { source: intent.linkedBy, seat: intent.controller } } : {}),
        } } });
      }
      // emit a summon event so "when summoned" triggers fire at the next window
      s = replace(s, { events: [...s.events, { kind: "summon", iid: intent.iid, player: intent.controller, special: true, ...(fromDiscard ? { fromDiscard: true } : {}) }] });
      s = poisonSS(s, intent.controller, intent.iid);
      return { state: s, result: undefined };
    }
    case "summonNamed": {
      if (ssBlocked(state)) return ssBlockedResult(state); // Center Stage T
      // search the listed zones (in order) for the first matching card and SS it
      const has = (iid: string) => state.instances[iid]?.cardId === intent.cardId;
      let found: string | undefined;
      let foundIn: "hand" | "deck" | "discard" | undefined;
      for (const zone of intent.from) {
        const pool = zone === "hand" ? player(state, intent.controller).hand
          : zone === "deck" ? state.mainDeck : state.discard;
        found = pool.find(has);
        if (found) { foundIn = zone; break; }
      }
      if (!found) {
        // searches may resolve without finding — the player is told, and a
        // searched deck is still shuffled
        let s = replace(state, { log: [...state.log, `player ${intent.controller} searches — nothing found`] });
        if (intent.from.includes("deck")) {
          const sh = shuffleWith(s.rngState, [...s.mainDeck]);
          s = replace(s, { rngState: sh.state, mainDeck: sh.value, log: [...s.log, "the deck is shuffled"] });
        }
        return { state: s, result: null };
      }
      let s = detach(state, found);
      s = placeOnBoard(s, intent.controller, found);
      s = replace(s, { events: [...s.events, { kind: "summon", iid: found, player: intent.controller, special: true }] });
      // a searched deck is always shuffled afterwards
      if (foundIn === "deck") {
        const sh = shuffleWith(s.rngState, [...s.mainDeck]);
        s = replace(s, { rngState: sh.state, mainDeck: sh.value, log: [...s.log, "the deck is shuffled"] });
      }
      s = poisonSS(s, intent.controller, found);
      return { state: s, result: found };
    }
    case "summonToken": {
      if (ssBlocked(state)) return ssBlockedResult(state); // Center Stage T
      const { state: minted, iid } = mintInstance(state, intent.cardId);
      let s = placeOnBoard(minted, intent.controller, iid);
      s = replace(s, { events: [...s.events, { kind: "summon", iid, player: intent.controller, special: true }] });
      s = replace(s, { log: [...s.log, `player ${intent.controller} Special Summons ${cardData(intent.cardId)?.name ?? intent.cardId}`] });
      s = poisonSS(s, intent.controller, iid);
      return { state: s, result: iid };
    }
    case "negateSummon": {
      const ann = state.announcedSummon;
      if (!ann || !state.players.some((p) => p.pid === ann.player && p.board.includes(ann.iid))) return { state, result: null };
      let s = replace(state, {
        announcedSummon: null,
        // any not-yet-processed on-summon event of that card never happened
        events: state.events.filter((e) => !(e.kind === "summon" && e.iid === ann.iid)),
        log: [...state.log, `the summon of ${state.instances[ann.iid]?.cardId || ann.iid} is negated (Solem)`],
      });
      return { state: s, result: ann.iid };
    }
    case "reveal": {
      // publicly reveal card(s): record their identities in the log (reveal = public
      // info), with each card's VALUE in brackets (☆ for a star/no-value card)
      const names = intent.iids.map((iid) => {
        const ci = state.instances[iid];
        if (!ci) return iid; // unknown instance -> id only
        const v = valueOf(state, iid);
        return `${ci.cardId ?? iid} (${v === null ? "☆" : v})`;
      });
      if (names.length === 0) return { state, result: undefined };
      return { state: replace(state, { log: [...state.log, `player ${intent.player} reveals ${names.join(", ")}`] }), result: undefined };
    }
    case "discardOneByOne": {
      // mass discards are SEQUENTIAL: queue the group; the session discards one at a
      // time (the chooser picking which falls next), a response window after each
      const q = intent.iids.filter((iid) => state.instances[iid]);
      if (q.length === 0) return { state, result: undefined };
      return { state: replace(state, { pendingEffectDiscards: [...state.pendingEffectDiscards, { chooser: intent.chooser, iids: q, by, source }] }), result: undefined };
    }
    case "discard": {
      if (protectedOnBoard(state, intent.iid, by)) return { state: protectLog(state, intent.iid), result: undefined };
      const phd = pizzaHutCode(state, intent.iid); // C.C.: a code counter instead of being discarded
      if (phd) return { state: phd, result: undefined };
      const lrd = liveRedirect(state, intent.iid); // LIVE!: overlay onto another character instead
      if (lrd) return { state: lrd, result: undefined };
      // The Brick ([B]): cannot be discarded from a hand by an effect -> reveal instead.
      if (isBrick(state.instances[intent.iid]?.cardId) && state.players.some((p) => p.hand.includes(intent.iid))) {
        return { state: replace(state, { log: [...state.log, `${state.instances[intent.iid]?.cardId ?? intent.iid} is revealed — cannot be discarded from the hand (Brick)`] }), result: undefined };
      }
      const holder = ownerOf(state, intent.iid); // before detach, for "if you discard this card"
      let s = detach(state, intent.iid);
      s = discardOrRedirect(s, intent.iid, holder ?? undefined); // Center Stage K may redirect to the deck
      s = resetOnLeavePlay(s, intent.iid);
      return { state: s, result: undefined };
    }
    case "discardRandom": {
      if (playerImmune(state, intent.player, by)) return { state, result: [] }; // SOA: immune to opponent discard
      // Pick `count` distinct cards from the hand via the threaded PRNG. Bricks ([B]) ARE
      // valid random targets, but a randomly-picked Brick is REVEALED, not discarded.
      let s = state;
      let st = s.rngState;
      let hand = [...player(s, intent.player).hand];
      const picked: string[] = [];
      for (let i = 0; i < intent.count && hand.length > 0; i++) {
        const r = nextInt(st, hand.length);
        st = r.state;
        const iid = hand[r.value]!;
        hand = hand.filter((x) => x !== iid);
        picked.push(iid);
      }
      s = replace(s, { rngState: st });
      const discarded: string[] = [];
      for (const iid of picked) {
        if (isBrick(s.instances[iid]?.cardId)) { // a Brick is revealed instead of discarded
          s = replace(s, { log: [...s.log, `${s.instances[iid]?.cardId ?? iid} is revealed — cannot be discarded from the hand (Brick)`] });
          continue;
        }
        s = detach(s, iid);
        s = discardOrRedirect(s, iid, intent.player); // Center Stage K may redirect to the deck
        s = resetOnLeavePlay(s, iid);
        discarded.push(iid);
      }
      return { state: s, result: discarded };
    }
    case "banishRandom": {
      if (playerImmune(state, intent.player, by)) return { state, result: [] }; // SOA: immune to opponent banish
      // Pick `count` distinct cards from the hand via the threaded PRNG and banish them
      // (no "discarded" events — banishing isn't discarding). BSoD: hits a hand. Bricks ([B])
      // ARE valid random targets, but a randomly-picked Brick is REVEALED, not banished.
      let s = state;
      let st = s.rngState;
      let hand = [...player(s, intent.player).hand];
      const picked: string[] = [];
      for (let i = 0; i < intent.count && hand.length > 0; i++) {
        const r = nextInt(st, hand.length);
        st = r.state;
        const iid = hand[r.value]!;
        hand = hand.filter((x) => x !== iid);
        picked.push(iid);
      }
      s = replace(s, { rngState: st });
      const banished: string[] = [];
      for (const iid of picked) {
        if (isBrick(s.instances[iid]?.cardId)) { // a Brick is revealed instead of banished
          s = replace(s, { log: [...s.log, `${s.instances[iid]?.cardId ?? iid} is revealed — cannot be banished from the hand (Brick)`] });
          continue;
        }
        s = detach(s, iid);
        s = replace(s, { banish: [iid, ...s.banish] }); // index 0 = pile top
        s = resetOnLeavePlay(s, iid);
        banished.push(iid);
      }
      if (banished.length) s = replace(s, { log: [...s.log, `player ${intent.player} banishes ${banished.length} random card(s) from hand`] });
      return { state: s, result: banished };
    }
    case "redistributeHands": {
      // SOA: a player immune to the redistributing opponent keeps their hand (excluded).
      const seats = intent.players.filter((pid) => !playerImmune(state, pid, by));
      if (seats.length < 2) return { state, result: undefined };
      // Pool the listed players' hands, shuffle via the PRNG, then re-deal each
      // player back their ORIGINAL number of cards ("shuffle hands together").
      const counts = seats.map((pid) => player(state, pid).hand.length);
      const pool = seats.flatMap((pid) => player(state, pid).hand);
      const sh = shuffleWith(state.rngState, pool);
      let s = replace(state, { rngState: sh.state });
      let idx = 0;
      const dealt = new Map<Seat, string[]>();
      seats.forEach((pid, i) => {
        dealt.set(pid, sh.value.slice(idx, idx + counts[i]!));
        idx += counts[i]!;
      });
      s = replace(s, { players: s.players.map((p) => (dealt.has(p.pid) ? { ...p, hand: dealt.get(p.pid)! } : p)) });
      return { state: s, result: undefined };
    }
    case "negateBelow": {
      // The resolving copy's link is the topmost one whose source is `self`; the
      // link directly below it is the effect it chained onto (LIFO — links below
      // never move while this one is on the chain). Mark it negated; its script is
      // skipped when it would resolve. Returns its source card iid for "that card".
      let j = -1;
      for (let i = state.chain.length - 1; i >= 0; i--) {
        if (state.chain[i]!.script?.self === intent.self) { j = i; break; }
      }
      if (j <= 0) return { state, result: null }; // nothing below to negate
      const below = state.chain[j - 1]!;
      const s = replace(state, {
        chain: state.chain.map((l, i) => (i === j - 1 ? { ...l, negated: true } : l)),
        log: [...state.log, `${below.effectId} is negated`],
      });
      return { state: s, result: below.script?.self ?? null };
    }
    case "addCounter": {
      const ci = state.instances[intent.iid];
      if (!ci) return { state, result: undefined };
      if (immuneFrom(state, intent.iid, by)) return { state, result: undefined }; // SOA/Supermodel
      const cur = ci.counters[intent.counter] ?? 0;
      const s = replace(state, {
        instances: { ...state.instances, [intent.iid]: { ...ci, counters: { ...ci.counters, [intent.counter]: cur + intent.amount } } },
      });
      return { state: s, result: undefined };
    }
    case "playerCounter": {
      if (playerImmune(state, intent.player, by)) return { state, result: undefined }; // SOA
      const p = player(state, intent.player);
      const cur = p.counters[intent.counter] ?? 0;
      const s = setPlayer(state, intent.player, { counters: { ...p.counters, [intent.counter]: cur + intent.amount } });
      return { state: s, result: undefined };
    }
    case "setEffectLock": {
      // Shoumakyou: opponents of `player` cannot activate effects for the rest of the turn
      const s = replace(state, { effectLockBy: intent.player, log: [...state.log, `Shoumakyou: opponents of player ${intent.player} cannot activate effects this turn`] });
      return { state: s, result: undefined };
    }
    case "scheduleHandShuffle": {
      // Diabolus ex Machina: at the end of `player`'s turn, shuffle their hand into the deck
      if (state.pendingHandShuffle.includes(intent.player)) return { state, result: undefined };
      return { state: replace(state, { pendingHandShuffle: [...state.pendingHandShuffle, intent.player] }), result: undefined };
    }
    case "winGame": {
      // Deus ex Machina: the player wins immediately (settle stops once `winner` is set)
      if (state.winner !== null) return { state, result: undefined };
      const s = replace(state, { winner: intent.player, phase: Phase.GAME_OVER, log: [...state.log, `player ${intent.player} wins the game (Deus ex Machina)`] });
      return { state: s, result: undefined };
    }
    case "shuffleHandIntoDeck": {
      if (playerImmune(state, intent.player, by)) return { state, result: undefined }; // SOA
      // Shuffle the player's whole hand into the Main deck (the deck is re-shuffled
      // so the returned cards land in random positions). The script draws separately.
      const p = player(state, intent.player);
      if (p.hand.length === 0) return { state, result: undefined };
      const sh = shuffleWith(state.rngState, [...state.mainDeck, ...p.hand]);
      let s = replace(state, { rngState: sh.state, mainDeck: sh.value });
      s = setPlayer(s, intent.player, { hand: [] });
      return { state: s, result: undefined };
    }
    case "reorderTop": {
      // place the chosen cards on top of the main deck in the given order; any that
      // left the deck since are skipped (robust to intervening draws).
      const order = intent.order.filter((iid) => state.mainDeck.includes(iid));
      const rest = state.mainDeck.filter((iid) => !order.includes(iid));
      return { state: replace(state, { mainDeck: [...order, ...rest] }), result: undefined };
    }
    case "takeDiscardTop": {
      if (playerImmune(state, intent.player, by)) return { state, result: null }; // SOA
      const top = state.discard[0];
      if (top === undefined) return { state, result: null };
      let s = replace(state, { discard: state.discard.slice(1) });
      const p = player(s, intent.player);
      s = setPlayer(s, intent.player, { hand: [...p.hand, top] });
      s = resetOnLeavePlay(s, top);
      return { state: s, result: top };
    }
    case "summonRandomFromHand": {
      if (ssBlocked(state)) return ssBlockedResult(state); // Center Stage T
      if (playerImmune(state, intent.player, by)) return { state, result: null }; // SOA
      const p = player(state, intent.player);
      if (p.hand.length === 0) return { state, result: null };
      const r = nextInt(state.rngState, p.hand.length); // consumes RNG regardless of outcome
      const iid = p.hand[r.value]!;
      let s = replace(state, { rngState: r.state });
      const cardId = s.instances[iid]?.cardId ?? null;
      if (!canSpecialSummon(cardId ?? undefined)) {
        // a Brick: reveal it publicly (log) and do NOT summon it
        s = replace(s, { log: [...s.log, `player ${intent.player} reveals ${cardId ?? iid} — cannot be summoned (Brick); not summoned`] });
        return { state: s, result: null };
      }
      s = detach(s, iid);
      s = placeOnBoard(s, intent.player, iid);
      s = replace(s, { events: [...s.events, { kind: "summon", iid, player: intent.player, special: true }] });
      s = poisonSS(s, intent.player, iid);
      return { state: s, result: iid };
    }
    case "meldFromDeckTop": {
      const top = state.mainDeck.slice(0, intent.count);
      if (top.length < intent.count) return { state, result: null }; // not enough cards
      const kind = meldKind(top.map((iid) => valueOf(state, iid)));
      if (kind === null) {
        // "else shuffle them back" — shuffle the whole main deck
        const sh = shuffleWith(state.rngState, state.mainDeck);
        return { state: replace(state, { mainDeck: sh.value, rngState: sh.state }), result: null };
      }
      let s = replace(state, { mainDeck: state.mainDeck.slice(intent.count) });
      const p = player(s, intent.player);
      s = setPlayer(s, intent.player, { meldZone: [...p.meldZone, { cards: [...top], kind, kan: false }] });
      // completing a meld draws a Faith card by default (RULES sec 5)
      if (s.faithDeck.length > 0) {
        const f = s.faithDeck[0]!;
        s = replace(s, { faithDeck: s.faithDeck.slice(1) });
        const p2 = player(s, intent.player);
        s = setPlayer(s, intent.player, { hand: [...p2.hand, f] });
      }
      return { state: s, result: top };
    }
    case "negateMeld": {
      const pm = state.pendingMeld;
      if (!pm) return { state, result: null };
      let s = replace(state, { pendingMeld: null, log: [...state.log, `the declared meld by player ${pm.player} is negated`] });
      if (!pm.special) s = setPlayer(s, pm.player, { meldedThisTurn: true }); // negated Normal Melds are "used up"
      return { state: s, result: null };
    }
    case "meldBoard": {
      // an effect Normal Meld from specific board materials (any boards). A bad set
      // (a participant left play, a material is protected, or no valid meld) fizzles.
      if (intent.materials.some((m) => immuneFrom(state, m, by))) {
        return { state: replace(state, { log: [...state.log, "meld fizzled: a material is immune to your effects"] }), result: null };
      }
      try {
        return { state: meldBoardCards(state, intent.player, intent.materials, intent.noFaith), result: intent.materials };
      } catch (e) {
        return { state: replace(state, { log: [...state.log, `meld fizzled: ${(e as Error).message}`] }), result: null };
      }
    }
    case "forcedDiscard": {
      // queue the discards; the reducer processes them one at a time (each an open
      // window) after the effect's chain resolves. Effect-removal-protected cards
      // are exempt (they cannot be removed from the board by effects).
      const groups = intent.groups
        .map((g) => ({ ...g, iids: g.iids.filter((iid) => !protectedOnBoard(state, iid, by)) })) // SOA/Supermodel/Immunize cards exempt
        .filter((g) => g.iids.length > 0);
      return { state: replace(state, { pendingForcedDiscards: groups }), result: undefined };
    }
    case "attachOverlay": {
      // succ / Lead Character: the card tucks beneath the host as an overlay. A
      // board source leaves play (losing in-play state; protection applies); a
      // hand source just moves. Optionally scheduled back to a hand at turn end.
      const host = state.instances[intent.host];
      if (!host || !state.players.some((p) => p.board.includes(intent.host))) return { state, result: null };
      let s = state;
      if (intent.from === "hand") {
        if (!s.players.some((p) => p.hand.includes(intent.card))) return { state, result: null };
        s = replace(s, { players: s.players.map((p) => ({ ...p, hand: p.hand.filter((x) => x !== intent.card) })) });
      } else {
        if (protectedOnBoard(s, intent.card, by)) return { state: protectLog(s, intent.card), result: null };
        if (!s.players.some((p) => p.board.includes(intent.card))) return { state, result: null }; // target left play
        s = replace(s, { players: s.players.map((p) => ({ ...p, board: p.board.filter((x) => x !== intent.card) })) });
        s = resetOnLeavePlay(s, intent.card);
      }
      const h = s.instances[intent.host]!;
      const cd = s.instances[intent.card]!;
      // an overlaid stack is FLAT: every material belongs to the top card. If the card
      // being overlaid already carries overlays, lift them ALL up to the host too (rather
      // than nesting a stack-within-a-stack).
      s = replace(s, { instances: { ...s.instances,
        [intent.card]: { ...cd, overlays: [] },
        [intent.host]: { ...h, overlays: [...h.overlays, intent.card, ...cd.overlays] },
      } });
      if (intent.returnAtEndOfTurnOf !== undefined) {
        s = replace(s, { pendingOverlayReturns: [...s.pendingOverlayReturns, { host: intent.host, card: intent.card, player: intent.returnAtEndOfTurnOf }] });
      }
      s = replace(s, { log: [...s.log, `${s.instances[intent.card]?.cardId || intent.card} is overlaid beneath ${h.cardId || intent.host}`] });
      return { state: s, result: intent.card };
    }
    case "coverWith": {
      // Lead Character: the hand card takes the host's board slot as the stack TOP; the
      // host (and its materials — flat stack) tuck beneath it. Not a summon: no event.
      const owner = state.players.find((p) => p.board.includes(intent.host))?.pid;
      if (owner === undefined) return { state, result: null }; // host left play -> fizzle
      if (!state.players.some((p) => p.hand.includes(intent.card))) return { state, result: null };
      let s = replace(state, { players: state.players.map((p) => ({ ...p, hand: p.hand.filter((x) => x !== intent.card) })) });
      const h = s.instances[intent.host]!;
      const c = s.instances[intent.card]!;
      s = replace(s, {
        players: s.players.map((p) => (p.pid === owner ? { ...p, board: p.board.map((x) => (x === intent.host ? intent.card : x)) } : p)),
        instances: { ...s.instances,
          [intent.host]: { ...h, overlays: [] },
          [intent.card]: { ...c, overlays: [...c.overlays, intent.host, ...h.overlays], pos: h.pos },
        },
      });
      if (intent.returnAtEndOfTurnOf !== undefined) {
        s = replace(s, { pendingOverlayReturns: [...s.pendingOverlayReturns, { host: intent.host, card: intent.card, player: intent.returnAtEndOfTurnOf, cover: true }] });
      }
      s = replace(s, { log: [...s.log, `${c.cardId || intent.card} covers ${h.cardId || intent.host} (overlaid on top)`] });
      return { state: s, result: intent.card };
    }
    case "flipUp": {
      const ci = state.instances[intent.iid];
      if (!ci || !ci.faceDown || !state.players.some((p) => p.board.includes(intent.iid))) return { state, result: undefined };
      if (immuneFrom(state, intent.iid, by)) return { state: immuneLog(state, intent.iid), result: undefined };
      const s = replace(state, {
        instances: { ...state.instances, [intent.iid]: { ...ci, faceDown: false } },
        log: [...state.log, `${ci.cardId || intent.iid} is flipped face-up`],
      });
      return { state: s, result: undefined };
    }
    case "setFaceDown": {
      // place a hand card face-down on a board (a "set" — NOT a summon, no events)
      let s = detach(state, intent.iid);
      const p = player(s, intent.player);
      s = setPlayer(s, intent.player, { board: [...p.board, intent.iid] });
      s = assignBoardPos(s, intent.player, intent.iid);
      const ci = s.instances[intent.iid];
      if (ci) s = replace(s, { instances: { ...s.instances, [intent.iid]: { ...ci, faceDown: true, tapped: false } } });
      return { state: s, result: undefined };
    }
    case "revealHandTo": {
      if (playerImmune(state, intent.owner, by)) return { state, result: undefined }; // SOA: an opponent can't reveal your hand
      const s = replace(state, {
        handRevealedTo: [...state.handRevealedTo, { owner: intent.owner, viewer: intent.viewer }],
        log: [...state.log, `player ${intent.owner} shows their hand to player ${intent.viewer}`],
      });
      return { state: s, result: undefined };
    }
    case "endHandReveal": {
      return { state: replace(state, {
        handRevealedTo: state.handRevealedTo.filter((r) => !(r.owner === intent.owner && r.viewer === intent.viewer)),
      }), result: undefined };
    }
    case "discardMeld": {
      if (playerImmune(state, intent.player, by)) return { state, result: null }; // SOA
      const p = player(state, intent.player);
      const meld = p.meldZone[intent.index];
      if (!meld) return { state, result: null }; // no such meld -> fizzle
      let s = replace(state, {
        players: state.players.map((pl) =>
          pl.pid === intent.player ? { ...pl, meldZone: pl.meldZone.filter((_, i) => i !== intent.index) } : pl,
        ),
      });
      s = replace(s, { log: [...s.log, `player ${intent.player} discards a ${meld.kind} meld (${meld.cards.length} cards)`] });
      // reverse so cards[0] ends up on top; Center Stage K may redirect each to the deck
      for (const iid of [...meld.cards].reverse()) s = discardOrRedirect(s, iid, intent.player);
      return { state: s, result: undefined };
    }
    case "scrambleBoards": {
      // Party Hard: every character moves to a uniformly random living board —
      // possibly its own ("(Including their own.)"). Board-protected/immune cards
      // stay put; overlays and in-play state ride along (a control move, not a
      // leave-play). One PRNG stream, destinations drawn in stable board order.
      const living = state.players.filter((p) => !p.eliminated).map((p) => p.pid);
      if (living.length === 0) return { state, result: undefined };
      let st = state.rngState;
      const moves: { iid: string; to: Seat }[] = [];
      for (const p of state.players) {
        if (p.eliminated) continue;
        for (const iid of p.board) {
          if (protectedOnBoard(state, iid, by)) continue; // SOA/Supermodel/Immunize cards stay put
          const r = nextInt(st, living.length);
          st = r.state;
          moves.push({ iid, to: living[r.value]! });
        }
      }
      let s = replace(state, { rngState: st });
      for (const m of moves) {
        s = replace(s, { players: s.players.map((p) => ({ ...p, board: p.board.filter((x) => x !== m.iid) })) });
        s = replace(s, { players: s.players.map((p) => (p.pid === m.to ? { ...p, board: [...p.board, m.iid] } : p)) });
        s = assignBoardPos(s, m.to, m.iid);
      }
      return { state: replace(s, { log: [...s.log, "the party scatters: all characters move to random boards"] }), result: undefined };
    }
    case "stun": {
      const ci = state.instances[intent.iid];
      if (!ci || !state.players.some((p) => p.board.includes(intent.iid))) return { state, result: undefined };
      if (immuneFrom(state, intent.iid, by)) return { state: immuneLog(state, intent.iid), result: undefined };
      // "until that player's NEXT turn ends": if it's currently their turn, defer the
      // imminent end-of-turn so the stun spans a full extra turn (MJG-C28).
      const skip = intent.nextTurn === true && state.activePlayer === intent.untilEndOfTurnOf;
      let s = replace(state, { instances: { ...state.instances, [intent.iid]: { ...ci, stunned: true } } });
      s = replace(s, {
        pendingUnstuns: [...s.pendingUnstuns, { iid: intent.iid, player: intent.untilEndOfTurnOf, ...(skip ? { skip: true } : {}) }],
        log: [...s.log, `${ci.cardId || intent.iid} is stunned (until player ${intent.untilEndOfTurnOf} ends their ${skip ? "next " : ""}turn)`],
      });
      return { state: s, result: undefined };
    }
    case "grantImmunity": {
      const ci = state.instances[intent.iid];
      if (!ci || !state.players.some((p) => p.board.includes(intent.iid))) return { state, result: undefined };
      // Supermodel is immune to ALL card effects — even beneficial ones
      if (immuneFrom(state, intent.iid, by)) return { state: immuneLog(state, intent.iid), result: undefined };
      let s = replace(state, { instances: { ...state.instances, [intent.iid]: { ...ci, protectedFromEffects: true } } });
      s = replace(s, {
        pendingImmunityEnds: [...s.pendingImmunityEnds, { iid: intent.iid, player: intent.player }],
        log: [...s.log, `${ci.cardId || intent.iid} is immunized until the start of player ${intent.player}'s next turn`],
      });
      return { state: s, result: undefined };
    }
    case "shuffleDeck": {
      const sh = shuffleWith(state.rngState, [...state.mainDeck]);
      return {
        state: replace(state, { rngState: sh.state, mainDeck: sh.value, log: [...state.log, "the deck is shuffled"] }),
        result: undefined,
      };
    }
    case "matchmakerBond": {
      // both must still be on a board for the bond to take hold
      const onBoard = (iid: string) => state.players.some((p) => p.board.includes(iid));
      if (intent.a === intent.b || !onBoard(intent.a) || !onBoard(intent.b)) return { state, result: undefined };
      if (immuneFrom(state, intent.a, by) || immuneFrom(state, intent.b, by)) return { state, result: undefined }; // SOA
      const s = replace(state, {
        matchmakerBonds: [...state.matchmakerBonds, { a: intent.a, b: intent.b, player: intent.player }],
        log: [...state.log, `Matchmaker: ${state.instances[intent.a]?.cardId || intent.a} and ${state.instances[intent.b]?.cardId || intent.b} are bonded`],
      });
      return { state: s, result: undefined };
    }
    case "shuffleIntoDeck": {
      // an effect removal: a board-protected/immune card stays put
      if (protectedOnBoard(state, intent.iid, by)) return { state: protectLog(state, intent.iid), result: undefined };
      const cardId = state.instances[intent.iid]?.cardId;
      let s = detach(state, intent.iid);
      s = resetOnLeavePlay(s, intent.iid);
      const sh = shuffleWith(s.rngState, [...s.mainDeck, intent.iid]);
      s = replace(s, { rngState: sh.state, mainDeck: sh.value, log: [...s.log, `${cardId || intent.iid} is shuffled into the deck`] });
      return { state: s, result: undefined };
    }
    case "scheduleEndTurnDiscard": {
      const s = replace(state, {
        pendingEndTurnDiscards: [...state.pendingEndTurnDiscards, { iid: intent.iid, player: intent.player }],
        log: [...state.log, `${state.instances[intent.iid]?.cardId || intent.iid} will be discarded at the end of player ${intent.player}'s turn`],
      });
      return { state: s, result: undefined };
    }
    case "setUnlimitedSummon": {
      // skip the first end-of-turn (the activator's current turn) so it lasts until their NEXT.
      const s = replace(state, {
        unlimitedSummon: { player: intent.player, skip: state.activePlayer === intent.player },
        log: [...state.log, `all players may Normal Summon freely until the end of player ${intent.player}'s next turn`],
      });
      return { state: s, result: undefined };
    }
    case "scheduleStartTurnSummon": {
      const s = replace(state, {
        pendingStartTurnSummons: [...state.pendingStartTurnSummons, { iid: intent.iid, player: intent.player }],
      });
      return { state: s, result: undefined };
    }
    case "armPoison": {
      const s = state.pendingPoison.includes(intent.player) ? state
        : replace(state, { pendingPoison: [...state.pendingPoison, intent.player] });
      return { state: s, result: undefined };
    }
    case "overlaySummon": {
      // "SS this card by overlaying it on X": X leaves its board beneath the summoned
      // card (losing in-play state), which arrives on X's owner's board — that player
      // controls it (board position = control). Emits a normal summon event.
      if (ssBlocked(state)) return ssBlockedResult(state); // Center Stage T
      if (protectedOnBoard(state, intent.onto, by)) return { state: protectLog(state, intent.onto), result: null };
      const ontoOwner = state.players.find((p) => p.board.includes(intent.onto))?.pid;
      if (ontoOwner === undefined) return { state, result: null }; // target left the board -> fizzle
      let s = detach(state, intent.iid); // out of the hand
      s = replace(s, { players: s.players.map((p) => ({ ...p, board: p.board.filter((x) => x !== intent.onto) })) });
      s = resetOnLeavePlay(s, intent.onto);
      const ci = s.instances[intent.iid]!;
      const onto = s.instances[intent.onto]!;
      // like an Xyz overlay: the target AND all of ITS materials become this card's
      // materials (overlay Zeus onto Dante -> Zeus carries Dante + Dante's materials)
      s = replace(s, { instances: { ...s.instances,
        [intent.onto]: { ...onto, overlays: [] },
        [intent.iid]: { ...ci, overlays: [...ci.overlays, intent.onto, ...onto.overlays], ssThisTurn: true, pos: onto.pos },
      } });
      s = replace(s, {
        players: s.players.map((p) => (p.pid === ontoOwner ? { ...p, board: [...p.board, intent.iid] } : p)),
        events: [...s.events, { kind: "summon", iid: intent.iid, player: ontoOwner, special: true }],
      });
      if (!s.instances[intent.iid]?.pos) s = assignBoardPos(s, ontoOwner, intent.iid);
      s = poisonSS(s, ontoOwner, intent.iid);
      return { state: s, result: intent.iid };
    }
    case "moveToBoard": {
      // a control/board move, NOT a leave-play: state (taps/mods/overlays) rides along
      if (protectedOnBoard(state, intent.iid, by)) return { state: protectLog(state, intent.iid), result: null };
      if (!state.players.some((p) => p.board.includes(intent.iid))) return { state, result: null }; // left play -> fizzle
      let s = replace(state, { players: state.players.map((p) => ({ ...p, board: p.board.filter((x) => x !== intent.iid) })) });
      s = replace(s, { players: s.players.map((p) => (p.pid === intent.player ? { ...p, board: [...p.board, intent.iid] } : p)) });
      s = assignBoardPos(s, intent.player, intent.iid);
      return { state: s, result: undefined };
    }
    case "skipTurn": {
      if (playerImmune(state, intent.player, by)) return { state, result: undefined }; // SOA
      const s = replace(state, {
        pendingSkips: [...state.pendingSkips, intent.player],
        log: [...state.log, `player ${intent.player} will skip their next turn`],
      });
      return { state: s, result: undefined };
    }
    case "scheduleEndTurn": {
      // "Monopoly": flag the turn to end; the session ends it once this resolution settles.
      return { state: replace(state, { pendingEndTurn: intent.player, log: [...state.log, `player ${intent.player}'s turn will end immediately`] }), result: undefined };
    }
    case "moveToExtra": {
      // "Upload" (Catbox): the card leaves wherever it is for the shared Extra Zone (losing
      // in-play state). Its ACTIVE then becomes usable by all players (legalActions).
      let s = detach(state, intent.iid);
      s = resetOnLeavePlay(s, intent.iid);
      s = replace(s, { extraZone: [...s.extraZone, intent.iid], log: [...s.log, `${s.instances[intent.iid]?.cardId || intent.iid} is placed in the Extra Zone`] });
      return { state: s, result: undefined };
    }
    case "armTurnControl": {
      if (playerImmune(state, intent.player, by)) return { state, result: undefined }; // SOA
      // "Geass": schedule control of the target's next turn AND record them as Geass'd
      // ("only once per game on the same player").
      const s = replace(state, {
        pendingTurnControl: [...state.pendingTurnControl, { player: intent.player, by: intent.by }],
        geassTargets: state.geassTargets.includes(intent.player) ? state.geassTargets : [...state.geassTargets, intent.player],
        log: [...state.log, `player ${intent.by} will control player ${intent.player}'s next turn (Geass)`],
      });
      return { state: s, result: undefined };
    }
    case "flipDown": {
      const ci = state.instances[intent.iid];
      if (!ci) return { state, result: undefined };
      if (immuneFrom(state, intent.iid, by)) return { state: immuneLog(state, intent.iid), result: undefined };
      if (abilityCardIds(state, intent.iid).some((id) => CANNOT_FLIP_FACEDOWN.has(id))) {
        return { state: replace(state, { log: [...state.log, `${ci.cardId} cannot be flipped face-down`] }), result: undefined };
      }
      if (!state.players.some((p) => p.board.includes(intent.iid))) return { state, result: undefined }; // only board cards flip
      let s = replace(state, { instances: { ...state.instances, [intent.iid]: { ...ci, faceDown: true } } });
      s = replace(s, { pendingUnflips: [...s.pendingUnflips, { iid: intent.iid, player: intent.player, until: intent.until ?? "startOfNextTurn" }] });
      return { state: s, result: undefined };
    }
    case "moveToHand": {
      if (protectedOnBoard(state, intent.iid, by)) return { state: protectLog(state, intent.iid), result: undefined };
      const fromDeck = state.mainDeck.includes(intent.iid);
      let s = detach(state, intent.iid);
      const p = player(s, intent.player);
      s = setPlayer(s, intent.player, { hand: [...p.hand, intent.iid] });
      // "added from the deck to your hand by a card effect" (NOT a draw — Watapon).
      // Deck pulls are public knowledge: log the identity.
      if (fromDeck) {
        s = replace(s, {
          events: [...s.events, { kind: "toHand", iid: intent.iid, player: intent.player }],
          log: [...s.log, `${s.instances[intent.iid]?.cardId || intent.iid} is added from the deck to player ${intent.player}'s hand`],
        });
      }
      s = resetOnLeavePlay(s, intent.iid);
      return { state: s, result: undefined };
    }
    case "preventBattleDiscard": {
      // a "would be discarded by battle … instead" replacement: remove this
      // player's pending battle losers so finalize won't discard them.
      const s = replace(state, {
        pendingDiscards: state.pendingDiscards.filter((d) => ownerOf(state, d.iid) !== intent.player),
      });
      return { state: s, result: undefined };
    }
    case "effectAttack": {
      // set up a pending battle that the next closeWindow settles. Guard the same
      // restrictions a declared attack checks: both on a board, the target isn't
      // protected ("cannot be attacked"), not bonded to the attacker (Matchmaker),
      // and not battle-discard-immune in a way that makes the attack pointless is
      // NOT guarded here (Supermodel just survives — handled in battleOutcome).
      const onBoard = (iid: string) => state.players.some((p) => p.board.includes(iid));
      if (!onBoard(intent.attacker) || !onBoard(intent.target)) return { state, result: null };
      if (cannotBeAttacked(state, intent.target)) return { state, result: null };
      if (matchmakerBonded(state, intent.attacker, intent.target)) return { state, result: null };
      if (immuneFrom(state, intent.target, by)) return { state, result: null }; // SOA: immune to an effect-driven attack
      const b: Battle = { attackerId: intent.attacker, targetId: intent.target, declared: true, oneSided: intent.oneSided };
      const s = replace(state, { pendingBattle: b });
      return { state: s, result: "attacked" };
    }
    case "untap": {
      const ci = state.instances[intent.iid];
      if (!ci) return { state, result: undefined };
      if (immuneFrom(state, intent.iid, by)) return { state, result: undefined }; // SOA/Supermodel
      return {
        state: replace(state, { instances: { ...state.instances, [intent.iid]: { ...ci, tapped: false } } }),
        result: undefined,
      };
    }
    case "statMod": {
      const ci = state.instances[intent.iid];
      if (!ci) return { state, result: undefined };
      if (immuneFrom(state, intent.iid, by)) return { state: immuneLog(state, intent.iid), result: undefined };
      const mod = { stat: intent.stat, op: intent.op, amount: intent.amount, duration: intent.duration };
      const s = replace(state, {
        instances: { ...state.instances, [intent.iid]: { ...ci, mods: [...ci.mods, mod] } },
      });
      return { state: s, result: undefined };
    }
    case "moveTo": {
      if (protectedOnBoard(state, intent.iid, by)) return { state: protectLog(state, intent.iid), result: undefined };
      // C.C. / LIVE!: a face-up Pizza Hut / Spinzaku that would be DISCARDED (top OR
      // bottom of the pile — RAWN) or BANISHED is redirected instead; The Brick can't
      // leave a hand this way either. Mandatory replacements — they apply to every
      // discard/banish destination, not just the `discard` intent.
      if (intent.to === "banish" || intent.to === "discardTop" || intent.to === "discardBottom") {
        const verb = intent.to === "banish" ? "banished" : "discarded";
        const phb = pizzaHutCode(state, intent.iid);
        if (phb) return { state: phb, result: undefined };
        const lrb = liveRedirect(state, intent.iid);
        if (lrb) return { state: lrb, result: undefined };
        // The Brick ([B]): cannot be discarded/banished from a hand by an effect -> reveal instead.
        if (isBrick(state.instances[intent.iid]?.cardId) && state.players.some((p) => p.hand.includes(intent.iid))) {
          return { state: replace(state, { log: [...state.log, `${state.instances[intent.iid]?.cardId ?? intent.iid} is revealed — cannot be ${verb} from the hand (Brick)`] }), result: undefined };
        }
      }
      const owner = intent.to === "hand" ? ownerOf(state, intent.iid) : null;
      const fromDeck = state.mainDeck.includes(intent.iid);
      let s = detach(state, intent.iid);
      switch (intent.to) {
        case "hand":
          if (owner !== null) {
            const p = player(s, owner);
            s = setPlayer(s, owner, { hand: [...p.hand, intent.iid] });
            // "added from the deck to your hand by a card effect" (Watapon)
            if (fromDeck) s = replace(s, { events: [...s.events, { kind: "toHand", iid: intent.iid, player: owner }] });
          }
          break;
        case "banish":
          s = replace(s, { banish: [intent.iid, ...s.banish] });
          break;
        case "deckTop":
          s = replace(s, { mainDeck: [intent.iid, ...s.mainDeck] });
          break;
        case "deckBottom":
          s = replace(s, { mainDeck: [...s.mainDeck, intent.iid] });
          break;
        case "discardTop":
          s = replace(s, { discard: [intent.iid, ...s.discard] });
          break;
        case "discardBottom":
          s = replace(s, { discard: [...s.discard, intent.iid] });
          break;
      }
      s = resetOnLeavePlay(s, intent.iid); // all moveTo destinations are non-board
      return { state: s, result: undefined };
    }
  }
}

// ---- interpreter ------------------------------------------------------------
/**
 * Run an effect script to completion, applying each yielded intent to the
 * state. Returns the resulting state. (No-input scripts only, for Phase 1a.)
 */
export function runEffect(
  state: GameState,
  script: EffectScript,
  base: { controller: Seat; self: string; targets?: readonly string[]; opt?: boolean; scratch?: Record<string, number> },
): GameState {
  const box = { state };
  const ctx: EffectContext = {
    controller: base.controller,
    self: base.self,
    targets: base.targets ?? [],
    opt: base.opt ?? false,
    state: () => box.state,
    scratch: base.scratch ?? {},
  };
  const gen = script(ctx);
  let send: IntentResult = undefined;
  for (;;) {
    const step = gen.next(send as never);
    if (step.done) break;
    const { state: next, result } = applyIntent(box.state, step.value, base.controller, base.self);
    box.state = next;
    send = result;
  }
  return box.state;
}

/**
 * EffectResolver (injected into the reducer): resolves ONE step of a chain link's
 * ability — the step at `link.step` (default 0) — and reports whether that was the
 * last step (`done`). Strict PSCT resolves step-by-step so a response window can
 * open between respondable steps; the reducer advances `link.step` while `done` is
 * false. Returns null for links with no runnable script (abstract test links / pure
 * trigger markers) so the reducer leaves them logged-only.
 */
/**
 * Re-validate a chain link's character targets at resolution. A character target
 * that was flipped FACE-DOWN since it was chosen is "non-existing" and drops out —
 * so the target-dependent part of the effect fizzles (scripts guard on ctx.targets),
 * while non-target parts (e.g. "…and Special Summon this card") still resolve.
 * Only `targetKind: "character"` effects re-validate; seat/number/deck/discard targets
 * and appended non-character picks pass through (they have no faceDown), as do effects
 * that intentionally target face-down cards (targetFaceDown).
 */
function liveTargets(state: GameState, script: NonNullable<ChainLink["script"]>): readonly string[] {
  const raw = script.targets ?? [];
  if (raw.length === 0) return raw;
  const spec = ACTIVATIONS[`${script.cardId}:${script.role}`];
  if (!spec || spec.targetKind !== "character" || spec.targetFaceDown) return raw;
  return raw.filter((iid) => !state.instances[iid]?.faceDown);
}

export function resolveChainLink(
  state: GameState,
  link: ChainLink,
): { state: GameState; done: boolean; scratch: Record<string, number> } | null {
  if (!link.script) return null;
  const steps = getSteps(link.script.cardId, link.script.role);
  const cursor = link.step ?? 0;
  const step = steps[cursor];
  if (!step) return null;
  const scratch = { ...(link.scratch ?? {}) }; // carried across this ability's steps
  const next = runEffect(state, step.run, {
    controller: link.script.controller,
    self: link.script.self,
    targets: liveTargets(state, link.script),
    opt: link.script.opt ?? false,
    scratch,
  });
  return { state: next, done: cursor + 1 >= steps.length, scratch };
}
