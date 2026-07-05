/**
 * Legal-action enumeration — answers "what can `seat` legally do right now?"
 *
 * Drives the real-game UX (card-click options, response prompts). Pure query
 * over GameState. Negative assumption: an ability is offered only if it is
 * registered in ACTIVATIONS (i.e. implemented with its activation condition);
 * every other card is treated as VANILLA (summon/attack/meld-material only).
 */
import * as M from "./reducer.js";
import type { GameState } from "./reducer.js";
import type { Seat } from "./rules.js";
import { canActivateOnce } from "./rules.js";
import { checkRestrictions } from "./restrictions.js";

/** Per-ability activation metadata (`${cardId}:${role}`). Presence = implemented. */
export interface ActivationSpec {
  from: "hand" | "board" | "discard"; // discard = activatable while in the discard pile (Resurrection)
  speed: "turn" | "anytime"; // turn = main-phase only; anytime = (At any time) quick/response
  category?: "S" | "A" | "F"; // for SPELL/ACTIVE restriction locks
  targets?: number; // number of targets chosen at activation
  // what the targets are (drives the client picker + validation); "opponent" and
  // "player" targets are seat ids — "player" includes the activator's own seat
  targetKind?: "character" | "discard" | "opponent" | "player";
  targetFaceDown?: boolean; // character targets are FACE-DOWN board cards (Useless Censors)
  targetFilter?: (state: GameState, iid: string, seat: Seat, source: string) => boolean; // extra per-character-target constraint (e.g. DEF == 1, or "your other character with an Active")
  opponentFilter?: (state: GameState, pid: Seat, seat: Seat) => boolean; // extra per-opponent-target constraint (e.g. "with no FEMALE characters")
  // cross-target constraint validated at activation (the whole chosen set, not each
  // target alone) — e.g. "3 characters on ONE opponent's board that form a meld".
  targetCombo?: (state: GameState, targets: string[], seat: Seat) => boolean;
  handMeld?: boolean; // effect is a special meld from the hand (>dama): client picks 3 hand cards
  /** Activation condition (text before the colon). Default: always activatable. */
  canActivate?: (state: GameState, seat: Seat, iid: string) => boolean;
}

// ---- per-card activation conditions (helpers) ------------------------------
const player = (s: GameState, seat: Seat) => s.players.find((p) => p.pid === seat)!;
const living = (s: GameState) => s.players.filter((p) => !p.eliminated);
const faceUp = (s: GameState, iid: string) => !s.instances[iid]?.faceDown;
const onAnyBoard = (s: GameState, cardId: string) =>
  s.players.some((p) => p.board.some((b) => faceUp(s, b) && s.instances[b]?.cardId === cardId));
// "more ATK, DEF, and VALUE than `selfIid`" — effective stats on both sides
// ("Stat changes are counted"), Bricks excluded from Special Summons.
const strongerThan = (s: GameState, hiid: string, selfIid: string): boolean => {
  const a = M.atkOf(s, selfIid), d = M.defOf(s, selfIid), v = M.valueOf(s, selfIid) ?? 0;
  return (
    M.canSpecialSummon(s.instances[hiid]?.cardId) &&
    M.atkOf(s, hiid) > a && M.defOf(s, hiid) > d && (M.valueOf(s, hiid) ?? 0) > v
  );
};
// Does this ability's parsed PSCT contain a "draw" action? ("Adding to hand is not
// drawing" — the parser tags those add_to_hand, so the registry check is exact.)
const abilityDraws = (effectId: string | undefined): boolean => {
  const steps = (M.ability(effectId)?.parsed as { steps?: { actions?: string[] }[] } | undefined)?.steps;
  return !!steps?.some((st) => st.actions?.includes("draw"));
};
// Tile Efficiency (MJG-M19): a face-up character that can be used as a meld material —
// not protected (Immunize), not Malware-locked, not effect-immune (Supermodel).
const meldableChar = (s: GameState, c: string): boolean =>
  faceUp(s, c) && s.instances[c]?.cardId != null &&
  !s.instances[c]?.protectedFromEffects && !M.cannotBeMelded(s, c) && !M.isEffectImmune(s, c);
// Does `pid` control 3 meldable face-up characters that form a valid meld?
const hasMeldTriple = (s: GameState, pid: Seat): boolean => {
  const v = player(s, pid).board.filter((b) => meldableChar(s, b)).map((b) => M.valueOf(s, b));
  for (let i = 0; i < v.length - 2; i++)
    for (let j = i + 1; j < v.length - 1; j++)
      for (let k = j + 1; k < v.length; k++)
        if (M.meldKind([v[i]!, v[j]!, v[k]!]) !== null) return true;
  return false;
};

// Effects that make a player SHOW or REVEAL cards from their HAND, and WHOSE hand:
//   "activator" — the effect's controller reveals their own hand;
//   "target"    — the targeted opponent (script.targets[0]) reveals their hand;
//   "both"      — both the controller and the target reveal a card from their hand.
// (Deck-reveal effects and discard effects are deliberately excluded — Koito's ruling.)
const HAND_REVEAL_EFFECTS: Record<string, "activator" | "target" | "both"> = {
  "MJG-C09:bottom": "both", // Honest Gamble
  "MJG-C10:bottom": "both", // Honester Gamble
  "MJG-C11:bottom": "both", // Honestest Gamble
  "MJG-C12:bottom": "both", // Double or Nothing
  "MJG-M19:bottom": "target", // We Gottem — reveal THEIR hand
  "MJG-M04:top": "activator", // Collusion — show YOUR hand
  "MJG-002:top": "activator", // Look at this Hag! — reveal this card from your hand
  "MJG-002:bottom": "activator", // >dama — reveal 3 from your hand
};

/** Counterspell: is the just-activated, not-yet-resolved top link a SPELL (category S)? */
function topIsSpell(state: GameState): boolean {
  const top = state.chain[state.chain.length - 1];
  return !!top && (top.step ?? 0) === 0 && !top.negated && !!top.effectId && ACTIVATIONS[top.effectId]?.category === "S";
}

/** Koito "Easily Startled": is the just-activated top effect one that makes `pid` show
 *  or reveal cards from their hand? (the chained, not-yet-resolved, step-0 link). */
function topRevealsHandOf(state: GameState, pid: Seat): boolean {
  const top = state.chain[state.chain.length - 1];
  if (!top || (top.step ?? 0) !== 0 || top.negated || !top.script) return false;
  const who = HAND_REVEAL_EFFECTS[top.effectId ?? ""];
  if (!who) return false;
  const activator = top.sourcePlayer;
  const target = Number(top.script.targets?.[0] ?? "-1");
  if (who === "activator") return pid === activator;
  if (who === "target") return pid === target;
  return pid === activator || pid === target; // both
}

// A card ability is player-activatable only if listed here (else vanilla).
// Each entry has its activation condition (text before the colon) encoded; the
// matching resolution body lives in CARD_SCRIPTS. All are SPELLs from hand that
// Special Summon the card itself when their condition holds.
export const ACTIVATIONS: Record<string, ActivationSpec> = {
  // Koito "Easily Startled" (At any time): chain to an activated effect that makes YOU
  // show/reveal cards in your hand — negate it and discard its card (see CARD_STEPS).
  "MJG-C31:top": { from: "hand", speed: "anytime", category: "S", canActivate: (s, seat) => topRevealsHandOf(s, seat) },
  // Counterspell "Mono Blue" (At any time): chain to an activated SPELL — cost-discard
  // this card, negate that SPELL and discard it. (MTG parody; steps in CARD_STEPS.)
  "MTG-001:top": { from: "hand", speed: "anytime", category: "S", canActivate: (s) => topIsSpell(s) },
  // Mooncakes "Emote Spam" (SPELL): target an opponent — this card jumps to THEIR hand, you draw 1.
  "MOON-001:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "opponent" },
  // Mooncakes "Soulless" (Active, once per game): everyone who never cast Emote Spam skips a turn.
  "MOON-001:bottom": { from: "board", speed: "turn", category: "A" },
  // Hanana "LTG": target an opponent; they discard a board card of their choice and you
  // Special Summon this card. Only legal against an opponent who HAS a board card to
  // discard. The board pick is a resolution choice (see RESOLVE_CHOICES).
  "MJG-C32:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "opponent",
    opponentFilter: (s, pid) => player(s, pid).board.length > 0,
    canActivate: (s, seat) => living(s).some((p) => p.pid !== seat && player(s, p.pid).board.length > 0) },
  // Friendly Uncle "Candy": target a [Cunny] or [Shota] character (any board); gain
  // control of it and Special Summon this card.
  "MJG-M08:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "character",
    targetFilter: (s, c) => { const t = s.instances[c]?.tribes ?? []; return t.includes("Cunny") || t.includes("Shota"); } },
  // Anon's Mom "Art" (FAITH, CbNS): Special Summon this card from hand by discarding cards
  // from your hand and/or board whose DEF totals exactly 7. The cost subset is picked at
  // activation (see ACTIVATION_CHOICES faithCost); offered only if a valid subset exists.
  "MJG-014:top": { from: "hand", speed: "turn", category: "F", canActivate: (s, seat, iid) => {
    const me = player(s, seat);
    const defs = [...me.hand, ...me.board].filter((x) => x !== iid).map((x) => M.faithCostStat(s, x, "def"));
    return M.canSumTo(defs, 7);
  } },
  // ما شاء الله (FAITH, CbNS): Special Summon from hand by discarding one card from hand or
  // board with 7 ATK, 8 DEF, or 6 VALUE (matching this card's stats). Cost picked at
  // activation (see ACTIVATION_CHOICES faithTribute).
  "MJG-016:top": { from: "hand", speed: "turn", category: "F", canActivate: (s, seat, iid) => {
    const me = player(s, seat);
    return [...me.hand, ...me.board].some((x) => x !== iid &&
      (M.faithCostStat(s, x, "atk") === 7 || M.faithCostStat(s, x, "def") === 8 || M.faithCostStat(s, x, "value") === 6));
  } },
  // Swordslut "Glorious Nippon Steel" (FAITH, CbNS): no cost — Special Summon this card
  // from hand and reduce all opponent characters' ATK to 0 for the rest of this turn.
  "MJG-027:top": { from: "hand", speed: "turn", category: "F" },
  // Resplendent Phoenix "Ashes" (FAITH, CbNS): discard your whole hand + board, open the
  // unlimited-Normal-Summon window, and schedule its return next turn. Always activatable.
  "MJG-042:top": { from: "hand", speed: "turn", category: "F" },
  // snek feet "Puberty" (FAITH, CbNS): Special Summon by overlaying it on a [Cunny].
  "MJG-048:top": { from: "hand", speed: "turn", category: "F", targets: 1, targetKind: "character",
    targetFilter: (s, c) => s.instances[c]?.tribes.includes("Cunny") ?? false },
  // Waschizo "Post-War Showa Era" (FAITH, CbNS): Special Summon by overlaying it on any
  // character that has battled 6+ times without leaving play (the `battles` counter).
  "MJG-C14:top": { from: "hand", speed: "turn", category: "F", targets: 1, targetKind: "character",
    targetFilter: (s, c) => (s.instances[c]?.battles ?? 0) >= 6 },
  // Waschizo "WASHI NO IIPIN" (Active, once per turn): draw 12 cards.
  "MJG-C14:bottom": { from: "board", speed: "turn", category: "A" },
  // Pizza Hut "C.C." (FAITH, CbNS): Special Summon this card from hand (gains a Code counter).
  "MJG-CC:top": { from: "hand", speed: "turn", category: "F" },
  // The Cart Driver "L.L." (FAITH, CbNS): Special Summon by overlaying it on "Pizza Hut".
  "MJG-ZERO:top": { from: "hand", speed: "turn", category: "F", targets: 1, targetKind: "character",
    targetFilter: (s, c) => s.instances[c]?.cardId === "MJG-CC" },
  // Spinzaku "Lancelot" (FAITH, CbNS): Special Summon by overlaying it on ANY character.
  "MJG-C21:top": { from: "hand", speed: "turn", category: "F", targets: 1, targetKind: "character" },
  // Sakurai "Guren" (FAITH, CbNS): Special Summon by overlaying it on any character WITHOUT a
  // [Type] tag (effective tribes — so a character another Heaven's Gate makes [Schizo] is out).
  "MJG-C22:top": { from: "hand", speed: "turn", category: "F", targets: 1, targetKind: "character",
    targetFilter: (s, c) => M.tribesOf(s, c).length === 0 },
  // Strawberry Cup "Summon - Berserker" (FAITH, CbNS): Special Summon by overlaying it on a
  // character YOU control (it gains the ATK of all overlaid cards — see the aura).
  "MJG-C23:top": { from: "hand", speed: "turn", category: "F", targets: 1, targetKind: "character",
    targetFilter: (s, c, seat) => s.players.find((p) => p.pid === seat)?.board.includes(c) ?? false },
  // Strawberry Cup "Class Card" (Active): reveal a hand card with an Active ability, use that
  // ability as this effect, and attach the card as an overlay (subject/role/targets gathered at
  // resolution — see RESOLVE_CHOICES classCard; reuses the Belly Dance copy machinery).
  "MJG-C23:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat) => player(s, seat).hand.some((iid) => activeRoles(s.instances[iid]?.cardId ?? "").length > 0) },
  // Chocolate Cup "Twin Personality" (FAITH, CbNS): Special Summon by overlaying it on a
  // character YOU control (it gains the ATK, DEF, and ABILITIES of all overlaid cards).
  "MJG-C25:top": { from: "hand", speed: "turn", category: "F", targets: 1, targetKind: "character",
    targetFilter: (s, c, seat) => s.players.find((p) => p.pid === seat)?.board.includes(c) ?? false },
  // Vanilla Cup "Summon - Caster" (FAITH, CbNS): Special Summon by overlaying it on a character
  // YOU control (it gains the DEF of all overlaid cards — see the aura).
  "MJG-C24:top": { from: "hand", speed: "turn", category: "F", targets: 1, targetKind: "character",
    targetFilter: (s, c, seat) => s.players.find((p) => p.pid === seat)?.board.includes(c) ?? false },
  // Vanilla Cup "Holy Grail" (Active): COST — attach a non-effect character from your hand or
  // board as an overlay (ACTIVATION_CHOICES attachNonEffect); then search the deck for any 1
  // card and Special Summon it (RESOLVE_CHOICES choose:"deck").
  "MJG-C24:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat, iid) => {
      const me = player(s, seat);
      return [...me.hand, ...me.board].some((c) => c !== iid && M.isNonEffect(s.instances[c]?.cardId) && !(me.board.includes(c) && s.instances[c]?.faceDown));
    } },
  // Freed Jyanshi (FAITH, CbNS): Special Summon by overlaying it on ANY character on ANY board
  // (it lands on that character's owner's board — overlay it onto an opponent to lock them).
  "MJG-000:top": { from: "hand", speed: "turn", category: "F", targets: 1, targetKind: "character" },
  // Catbox "Upload" (FAITH): place this + a non-Faith hand card (with an ACTIVE) in the Extra
  // Zone; that card's ACTIVE becomes usable by all players once per turn (see ACTIVATION_CHOICES
  // upload + the Extra-Zone offering in legalActions).
  "NYA-999:top": { from: "hand", speed: "turn", category: "F",
    canActivate: (s, seat, iid) => player(s, seat).hand.some((h) => h !== iid && isUploadable(cardIdOf(s, h))) },
  // June 4th Incident "How did he know?" (FAITH, CbNS): reveal this + 2 other hand cards to form
  // a 3-char serial code (this card and ☆ cards are wild), search the Main Deck for a card whose
  // id-code matches, add it to hand, and Special Summon this. Target picked at activation
  // (see ACTIVATION_CHOICES serialCode).
  "MJG-117633:top": { from: "hand", speed: "turn", category: "F", canActivate: (s, seat, iid) => {
    const others = player(s, seat).hand.filter((h) => h !== iid);
    return others.length >= 2 && s.mainDeck.some((d) => serialFormable(s, others, d));
  } },
  // Shamiko "Shamiko Punch" (Spell, from hand): reveal this card and target a character with
  // 0 DEF (effective); discard that character. Shamiko stays in hand (only the target leaves).
  "SHA-001:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "character",
    targetFilter: (s, c) => M.defOf(s, c) === 0 },
  // Blue-Eyes Ultimate Dragon "Polymerization" (FAITH, CbNS): Special Summon by overlaying it
  // on "Blue-Eyes White Dragon" (LOB-001).
  "MJG-C18:top": { from: "hand", speed: "turn", category: "F", targets: 1, targetKind: "character",
    targetFilter: (s, c) => s.instances[c]?.cardId === "LOB-001" },
  // Blue-Eyes Ultimate Dragon "De-Fusion" (Spell, from HAND): discard this card FROM YOUR
  // HAND; Special Summon up to 3 "Blue-Eyes White Dragon" from your hand, the deck, or
  // discard pile (see ACTIVATION_CHOICES deFusion). Offered when a LOB-001 is available.
  "MJG-C18:bottom": { from: "hand", speed: "turn", category: "S",
    canActivate: (s, seat) => [...player(s, seat).hand, ...s.mainDeck, ...s.discard].some((c) => s.instances[c]?.cardId === "LOB-001") },
  // CEOofLuckshitting "Monopoly" (FAITH, CbNS): Special Summon this card, draw 5, then end your
  // turn. Step-wise (windows before the draw and the end-turn) — see CARD_STEPS.
  "MJG-M05:top": { from: "hand", speed: "turn", category: "F" },
  // Mistakes into Miracles "Knot" (FAITH, CbNS): Special Summon from hand by discarding cards
  // from hand and/or board whose stats total EXACTLY 6 ATK and 9 DEF (see ACTIVATION_CHOICES
  // faithCost). Offered only when such a subset exists.
  "MJG-WAN:top": { from: "hand", speed: "turn", category: "F", canActivate: (s, seat, iid) => {
    // "your hand and/or ANY board": own hand + own board + opponents' FACE-UP board cards
    const me = player(s, seat);
    const pool = [...me.hand, ...me.board,
      ...s.players.filter((p) => p.pid !== seat && !p.eliminated).flatMap((p) => p.board.filter((x) => !s.instances[x]?.faceDown))];
    const items = pool.filter((x) => x !== iid).map((x) => ({ atk: M.faithCostStat(s, x, "atk"), def: M.faithCostStat(s, x, "def") }));
    return M.canSumToDims(items, 6, 9);
  } },
  // Mistakes into Miracles "Itadakimasu" (Active): Special Summon every card in the banish pile.
  "MJG-WAN:bottom": { from: "board", speed: "turn", category: "A", canActivate: (s) => s.banish.length > 0 },
  // Blood Sprout "Tra" (FAITH, CbNS): Special Summon from hand by discarding cards from hand
  // and/or board whose ATK totals EXACTLY 7 (on-board stats; 0-ATK cards allowed). See
  // ACTIVATION_CHOICES faithCost. ("Tuorps" start-of-turn passive is session-driven.)
  "MJG-410:top": { from: "hand", speed: "turn", category: "F", canActivate: (s, seat, iid) => {
    const me = player(s, seat);
    const items = [...me.hand, ...me.board].filter((x) => x !== iid).map((x) => ({ atk: M.faithCostStat(s, x, "atk"), def: M.faithCostStat(s, x, "def") }));
    return M.canSumToDims(items, 7, undefined);
  } },
  // Cum Chalice "Gate of Babyron" (Spell, from hand): Special Summon every card in your hand
  // one at a time (this card first), each attacking if possible; then return all other board
  // cards to your hand and end your turn. Resolution is session-driven (see pendingBabylon) —
  // no targets/script here; the chain link resolves as a no-op once the rampage is queued.
  "MJG-C26:bottom": { from: "hand", speed: "turn", category: "S" },
  // The Cart Driver "Geass" (Active): control a targeted opponent's next turn — only once per
  // game on the same player (opponentFilter excludes already-Geass'd seats).
  "MJG-ZERO:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    opponentFilter: (s, pid) => !s.geassTargets.includes(pid),
    canActivate: (s, seat) => living(s).some((p) => p.pid !== seat && !s.geassTargets.includes(p.pid)) },
  // snek feet "Snake Bite" (Active): poison a targeted opponent.
  "MJG-048:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    canActivate: (s, seat) => living(s).some((p) => p.pid !== seat) },
  // Magical Sands "Depths of Hell" (FAITH, CbNS): Special Summon from hand by banishing 6
  // OTHER hand cards (picked at activation — see ACTIVATION_CHOICES banishHandCost).
  "MJG-C13:top": { from: "hand", speed: "turn", category: "F",
    canActivate: (s, seat, iid) => player(s, seat).hand.filter((x) => x !== iid && !M.isBrick(s.instances[x]?.cardId)).length >= 6 },
  // Magical Sands "The Second Hand" (Active, once per turn): take 3 cards from the discard
  // pile that form a valid meld and make a Special Meld with them.
  "MJG-C13:bottom": { from: "board", speed: "turn", category: "A", targets: 3, targetKind: "discard",
    targetCombo: (s, targets, _seat) => targets.length === 3 && targets.every((t) => s.discard.includes(t)) && M.meldKind(targets.map((t) => M.valueOf(s, t))) !== null,
    canActivate: (s) => {
      const v = s.discard.map((iid) => M.valueOf(s, iid));
      for (let i = 0; i < v.length - 2; i++) for (let j = i + 1; j < v.length - 1; j++) for (let k = j + 1; k < v.length; k++)
        if (M.meldKind([v[i]!, v[j]!, v[k]!]) !== null) return true;
      return false;
    } },
  // Touch Fluffy Tail "9 Tailed Fox" (FAITH, CbNS): SS by shuffling the top 9 of the
  // discard pile into the deck (cost), then gain control of all [Furry] characters.
  "MJG-036:top": { from: "hand", speed: "turn", category: "F", canActivate: (s) => s.discard.length >= 9 },
  // Touch Fluffy Tail "Sacred Enjou" (Active): target ANOTHER character; gain control of
  // it, but discard it at the end of this turn.
  "MJG-036:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "character",
    targetFilter: (s, c, seat, src) => c !== src },
  // Crimson Chemist "A Worthy Disciple" (Active, once per player): a modal — choose up to
  // 3 different effects (some with a value/target sub-pick), gathered at activation (see
  // ACTIVATION_CHOICES disciple). once_per_player is enforced via the registry flag.
  "MJG-040:top": { from: "board", speed: "turn", category: "A" },
  // HOLY MAHJONG "Resurrection" (FAITH, CbNS): while in the DISCARD pile, the current
  // player may discard 3 hand cards (cost) and Special Summon it. Offered via the discard
  // loop; needs 3 cards in hand to pay.
  "MJG-025:top": { from: "discard", speed: "turn", category: "F", canActivate: (s, seat) => player(s, seat).hand.filter((x) => !M.isBrick(s.instances[x]?.cardId)).length >= 3 },
  // HOLY MAHJONG "New Covenant" (Active): banish this card; all players shuffle their hand
  // and board into the deck, then draw 5. Always usable while it is on the board.
  "MJG-025:bottom": { from: "board", speed: "turn", category: "A" },
  // Madoka "Cold Attitude" (At any time): target a character YOU control; banish it and
  // Special Summon this card (an escape/redirect). Offered only with a valid own target.
  "MJG-C33:top": { from: "hand", speed: "anytime", category: "S", targets: 1, targetKind: "character",
    targetFilter: (s, c, seat) => player(s, seat).board.includes(c) },
  // No "Solem" (At any time): an OPPONENT just played a card (chain to it); the cost is to
  // discard one of YOUR melds. Then negate + discard that card, then discard this card.
  "MJG-C34:top": { from: "hand", speed: "anytime", category: "S", canActivate: (s, seat) => {
    if (player(s, seat).meldZone.length === 0) return false; // must have a meld to pay the cost
    const top = s.chain[s.chain.length - 1];
    if (top) return (top.step ?? 0) === 0 && !top.negated && top.sourcePlayer !== seat;
    // empty chain: an OPPONENT's summon was just announced (Solemn-Judgment style) —
    // Solem can chain to negate + destroy the summon itself
    const ann = s.announcedSummon;
    return !!ann && ann.player !== seat && s.players.some((p) => p.pid === ann.player && p.board.includes(ann.iid));
  } },
  // Catan Bullies "Revenge": you have the fewest melds (not tied).
  "MJG-C17:top": { from: "hand", speed: "turn", category: "S", canActivate: (s, seat) => {
    const m = player(s, seat).meldZone.length;
    return living(s).every((p) => p.pid === seat || p.meldZone.length > m);
  } },
  // Catan Bullies "Treasurer" (Active): reveal the top 2 of the deck and act on their
  // VALUE-sum. Needs 2 cards to reveal.
  "MJG-C17:bottom": { from: "board", speed: "turn", category: "A", canActivate: (s) => s.mainDeck.length >= 2 },
  // Chuuni "Imouto": a character on your board has more ATK, DEF AND VALUE than this card.
  "MJG-031:top": { from: "hand", speed: "turn", category: "S", canActivate: (s, seat, iid) => {
    const a = M.atkOf(s, iid), d = M.defOf(s, iid), v = M.valueOf(s, iid) ?? 0;
    return player(s, seat).board.some((b) => faceUp(s, b) &&
      M.atkOf(s, b) > a && M.defOf(s, b) > d && (M.valueOf(s, b) ?? 0) > v);
  } },
  // p*n*s "It's so small": you have the biggest hand (not tied).
  "MJG-041:top": { from: "hand", speed: "turn", category: "S", canActivate: (s, seat) => {
    const h = player(s, seat).hand.length;
    return living(s).every((p) => p.pid === seat || p.hand.length < h);
  } },
  // ywnbaw7: "What are the odds..." (MJG-C08) is on any board.
  "MJG-C07:top": { from: "hand", speed: "turn", category: "S", canActivate: (s) => onAnyBoard(s, "MJG-C08") },
  // What are the odds...: "ywnbaw7" (MJG-C07) is on any board.
  "MJG-C08:top": { from: "hand", speed: "turn", category: "S", canActivate: (s) => onAnyBoard(s, "MJG-C07") },
  // Fujoshi Doujinshi "BL": 2+ MALE characters total on players' boards (gender
  // is hand-curated card data: "M"/"F"/"N" in base_set.json).
  "MJG-028:top": { from: "hand", speed: "turn", category: "S", canActivate: (s) => {
    let males = 0;
    for (const p of s.players) {
      if (p.eliminated) continue;
      for (const b of p.board) {
        const ci = s.instances[b];
        if (ci && !ci.faceDown && M.cardData(ci.cardId)?.gender === "M") males++;
      }
    }
    return males >= 2;
  } },
  // SMMR "1, 2, 3, lets go": exactly 3 characters on your board.
  "MJG-M16:top": { from: "hand", speed: "turn", category: "S", canActivate: (s, seat) =>
    player(s, seat).board.filter((b) => faceUp(s, b)).length === 3 },
  // Mixing Magic "c" (Active): all players draw up to 4 cards in hand, anticlockwise.
  // No condition — always activatable (a no-op when everyone already has 4+).
  "MJG-M16:bottom": { from: "board", speed: "turn", category: "A" },
  // The Hacker known as 4chan "BSoD": target an opponent; SS this card to THEIR board,
  // then banish a random card from their hand. Needs a living opponent.
  "HTTP-404:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "opponent",
    canActivate: (s, seat) => living(s).some((p) => p.pid !== seat) },
  // Temeraire "Breast Expansion": discard this card; then EITHER draw until you have 5
  // cards in hand, or draw 2 (the mode is chosen at resolution). Always activatable.
  "SOA-C02:top": { from: "hand", speed: "turn", category: "S" },
  // love "nya": discard this card; Special Summon a "BIG ICHIHIME" (NYA-000) token.
  "NYA-001:top": { from: "hand", speed: "turn", category: "S" },
  // amaekoromo "Haitei Raoyue" (Active): reveal & draw the bottom card of the deck, then
  // optionally meld it with 2 of your board / discard-top cards. Needs a deck to draw.
  "MJG-C03:bottom": { from: "board", speed: "turn", category: "A", canActivate: (s) => s.mainDeck.length > 0 },
  // i can't believe toki is fucking dead "Futuristic Player" (Active): look at the top 3
  // of the deck, add 1 to your hand, then this card loses 1 DEF. Needs a deck.
  "MJG-C05:bottom": { from: "board", speed: "turn", category: "A", canActivate: (s) => s.mainDeck.length > 0 },
  // Copebots "Log Review" (Active): reveal the top card; if it could meld with 2 of your
  // board cards, give it to an opponent — else draw it. Needs a deck to reveal.
  "MJG-C06:bottom": { from: "board", speed: "turn", category: "A", canActivate: (s) => s.mainDeck.length > 0 },
  // ywnbaw7 "Diabolus ex Machina" (Active): if this is your ONLY board card and your hand
  // is empty, draw the whole deck (then shuffle your hand back at end of turn).
  "MJG-C07:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat) => player(s, seat).board.length === 1 && player(s, seat).hand.length === 0 },
  // What are the odds... "Deus ex Machina" (Active): if this is your ONLY board card and
  // your hand is empty, you win the game.
  "MJG-C08:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat) => player(s, seat).board.length === 1 && player(s, seat).hand.length === 0 },
  // i stab inside ichihime nya "Honest Gamble" (Active): target an opponent (with a hand);
  // both reveal a random hand card, the lower VALUE discards it. Needs both to have hands.
  "MJG-C09:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    opponentFilter: (s, pid) => player(s, pid).hand.length > 0,
    canActivate: (s, seat) => player(s, seat).hand.length > 0 && living(s).some((p) => p.pid !== seat && player(s, p.pid).hand.length > 0) },
  // Ohohojousama "Honester Gamble" (Active): same reveal duel as Honest Gamble, but the
  // HIGHER VALUE draws 2. Needs both players to have hands.
  "MJG-C10:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    opponentFilter: (s, pid) => player(s, pid).hand.length > 0,
    canActivate: (s, seat) => player(s, seat).hand.length > 0 && living(s).some((p) => p.pid !== seat && player(s, p.pid).hand.length > 0) },
  // Sin Titulo "Honestest Gamble" (Active): same lowest-VALUE-discards duel, but each
  // player CHOOSES their reveal. Needs both players to have hands.
  "MJG-C11:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    opponentFilter: (s, pid) => player(s, pid).hand.length > 0,
    canActivate: (s, seat) => player(s, seat).hand.length > 0 && living(s).some((p) => p.pid !== seat && player(s, p.pid).hand.length > 0) },
  // Nina Derank Stream "Beautification Council" (Active): all players discard half their
  // hand. Only worth activating while someone holds >= 2 cards (floor >= 1).
  "MJG-C12:top": { from: "board", speed: "turn", category: "A",
    canActivate: (s) => s.players.some((p) => !p.eliminated && p.hand.length >= 2) },
  // Nina Derank Stream "Double or Nothing" (Active): random reveal duel; if you revealed
  // the lower VALUE discard your whole hand, else draw equal to your hand size.
  "MJG-C12:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    opponentFilter: (s, pid) => player(s, pid).hand.length > 0,
    canActivate: (s, seat) => player(s, seat).hand.length > 0 && living(s).some((p) => p.pid !== seat && player(s, p.pid).hand.length > 0) },
  // All My Mahjong Friends Have Died "Shoumakyou" (At any time): AFTER an opponent fully
  // resolves an effect (end of chain, not during) — discard this card to lock opponents
  // out of activating effects for the rest of this turn. Offered only when the chain is
  // empty, an opponent has activated an effect this turn, and the lock isn't already up.
  "MJG-C04:top": { from: "hand", speed: "anytime", category: "S", canActivate: (s, seat) =>
    s.chain.length === 0 && s.effectLockBy === null && living(s).some((p) => p.pid !== seat && s.effectActsThisTurn.includes(p.pid)) },
  // FU-FU-FUCK SHAMIKO "keikumusume_0.png" (At any time): an OPPONENT has DECLARED a meld
  // using the discard-pile top — chain to negate it and steal that discarded card.
  "MJG-HAT:top": { from: "hand", speed: "anytime", category: "S", canActivate: (s, seat) => {
    const pm = s.pendingMeld;
    return !!pm && pm.player !== seat && !pm.fromHand && s.discard.length > 0 && pm.materials.includes(s.discard[0]!);
  } },
  // Flow Book 1 "Tile Efficiency" (At any time): SS this card AND target 3 meldable
  // characters on ONE opponent's board that form a valid meld — force that meld for
  // them (no Faith draw). Offered only when such a triple exists.
  "MJG-M19:top": { from: "hand", speed: "anytime", category: "S", targets: 3, targetKind: "character",
    targetFilter: (s, c, seat) => s.players.some((p) => p.pid !== seat && !p.eliminated && p.board.includes(c)) && meldableChar(s, c),
    targetCombo: (s, targets, seat) => {
      const owner = s.players.find((p) => p.pid !== seat && !p.eliminated && targets.every((t) => p.board.includes(t)));
      return !!owner && targets.length === 3 && M.meldKind(targets.map((t) => M.valueOf(s, t))) !== null;
    },
    canActivate: (s, seat) => living(s).some((p) => p.pid !== seat && hasMeldTriple(s, p.pid)) },
  // Flow Book 1 "We Gottem" (Active): target an opponent and reveal their hand; add all
  // their [Cunny] and [Shota] cards to your hand. Needs a living opponent.
  // Mutsugaki "Explosive Aria": place a (non-Brick) hand card on any player's board;
  // it discards everything it touches, then itself. Pick + placement at resolution.
  "MSGK-C30:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat) => player(s, seat).hand.some((h) => !M.isBrick(s.instances[h]?.cardId)) },
  "MJG-M19:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    canActivate: (s, seat) => living(s).some((p) => p.pid !== seat) },
  // The Jongker "BAAAANG" (At any time): target an opponent with 10+ cards in hand;
  // discard your hand, then they discard theirs. Offered only vs a 10+ hand.
  "MJG-M21:top": { from: "hand", speed: "anytime", category: "S", targets: 1, targetKind: "opponent",
    opponentFilter: (s, pid) => player(s, pid).hand.length >= 10 },
  // The Jongker "Joker's Joke" (Active): each player draws 3, discards 2 random, gains
  // a Clown counter (anticlockwise). No condition — always activatable.
  "MJG-M21:bottom": { from: "board", speed: "turn", category: "A" },
  // Majsoul Secret Room "Secret Rumors" (Active): COST — place 2 hand cards face-down
  // on your board; target an opponent who blindly takes one of them. Needs 2 hand
  // cards to place and a living opponent.
  "MJG-M22:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    canActivate: (s, seat) => player(s, seat).hand.length >= 2 && living(s).some((p) => p.pid !== seat) },
  // Elegant "Buying gf" (Active): target an opponent's FEMALE character; give 2 of your
  // hand cards to its owner and take control of it. Needs 2 hand cards to give.
  "MJG-M23:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "character",
    targetFilter: (s, c, seat) => s.players.some((p) => p.pid !== seat && !p.eliminated && p.board.includes(c)) && M.cardData(s.instances[c]?.cardId)?.gender === "F",
    canActivate: (s, seat) => player(s, seat).hand.length >= 2 },
  // Sechs with Zechs "Pack Hunting": you control a [Furry].
  "MJG-M15:bottom": { from: "hand", speed: "turn", category: "S", canActivate: (s, seat) =>
    player(s, seat).board.some((b) => faceUp(s, b) && s.instances[b]?.tribes.includes("Furry")) },
  // Tea Leaves: at least two VALUE-2 cards in the discard pile.
  "MJG-M22:top": { from: "hand", speed: "turn", category: "S", canActivate: (s) =>
    s.discard.filter((iid) => M.valueOf(s, iid) === 2).length >= 2 },

  // Look at this Hag! "I'm Looking!": all players draw 1 (once per turn). No
  // activation condition; the once-per-turn cap is enforced via the parsed flag.
  "MJG-002:top": { from: "hand", speed: "turn", category: "S" },
  // Nyagger "Chi on First Turn": this is your first action this turn (ruling:
  // activate right after drawing). SS this card from hand, then draw 1.
  "MJG-001:top": { from: "hand", speed: "turn", category: "S", canActivate: (s, seat) =>
    seat === s.activePlayer && !player(s, seat).actedThisTurn },

  // --- on-board ACTIVE abilities (using one taps the card) ---
  // Nyagger "What's Yaku?": Special Summon the top card of the deck.
  "MJG-001:bottom": { from: "board", speed: "turn", category: "A" },
  // Look at this Hag! ">dama": reveal 3 cards from your hand and make a valid
  // Special Meld with them. Client-driven hand-meld; using it taps the card.
  "MJG-002:bottom": { from: "board", speed: "turn", category: "A", handMeld: true },
  // Cheese Chotto "Koromo Janai zo!": draw the bottom card of the deck.
  "MJG-003:bottom": { from: "board", speed: "turn", category: "A" },
  // Rigged Hands "Mr Rabbit": target ANY character (any board, incl. itself);
  // return it to the owner's hand. Offered only when a face-up character exists
  // (always true while this card is on the board — it can bounce itself).
  "MJG-018:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "character" },
  // TO Here "B&": discard this card; place a targeted character on the bottom of
  // the deck. Only legal when some face-up character is on a board to target.
  "AS4-PIN:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "character",
    canActivate: (s) => s.players.some((p) => !p.eliminated && p.board.some((b) => faceUp(s, b) && s.instances[b]?.cardId !== null)) },
  // TO Here "Thread Moved": CHOOSE a discarded card -> discard top, then you can
  // return this card to hand. Both are resolution decisions (see RESOLVE_CHOICES),
  // so nothing is picked at activation. Only legal when the discard is non-empty.
  "AS4-PIN:bottom": { from: "board", speed: "turn", category: "A", canActivate: (s) => s.discard.length > 0 },
  // Miko "MIKO MIKO MII" (At any time): a hand-trap usable only while one of YOUR
  // characters is awaiting a battle discard (the battle-discard response window).
  // Special Summons itself instead, saving your card.
  "UGR-005:top": { from: "hand", speed: "anytime", category: "S",
    canActivate: (s, seat) =>
      s.pendingDiscards.some((d) => s.players.some((p) => p.pid === seat && p.board.includes(d.iid))) },
  // Good Morning Sirs! "iTunes Gift Card": target an opponent and offer them this
  // card; they decide (redeem -> their hand + you draw 2; else you Special Summon it).
  "MJG-015:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "opponent",
    canActivate: (s, seat) => living(s).some((p) => p.pid !== seat) },
  // Good Morning Sirs! "Belly Dance": target ANOTHER character you control and use
  // one of its Active abilities (top or bottom); its own role/targets/choices are
  // gathered at resolution (see RESOLVE_CHOICES bellyDance).
  "MJG-015:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "character",
    targetFilter: (s, c, seat, src) => c !== src && (s.players.find((p) => p.pid === seat)?.board.includes(c) ?? false) && activeRoles(s.instances[c]?.cardId ?? "").length > 0 },
  // Literally Who? "Mahjong Crimes?" (At any time): a card was discarded by battle this turn.
  "MJG-012:top": { from: "hand", speed: "anytime", category: "S", canActivate: (s) => s.battleDiscardedThisTurn },
  // Jane4 "Useless Censors" (At any time, repeatable): reveal this card and target a
  // FACE-DOWN character; flip it face-up. The card stays in hand.
  "MJG-047:top": { from: "hand", speed: "anytime", category: "S", targets: 1, targetKind: "character", targetFaceDown: true },
  // I'm at the bar... "Siscon" (At any time): target a FEMALE with strictly less
  // ATK, DEF, and VALUE than this card; steal it to your hand, then SS this card.
  "MJG-M02:top": { from: "hand", speed: "anytime", category: "S", targets: 1, targetKind: "character",
    targetFilter: (s, c, _seat, src) =>
      M.cardData(s.instances[c]?.cardId)?.gender === "F" &&
      M.atkOf(s, c) < M.atkOf(s, src) && M.defOf(s, c) < M.defOf(s, src) &&
      (M.valueOf(s, c) ?? Infinity) < (M.valueOf(s, src) ?? -Infinity) },
  // I'm at the bar... "The Usual?": target an opponent; the top-3 reveal happens at
  // activation (pre-colon). Needs a deck to reveal.
  "MJG-M02:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    canActivate: (s) => s.mainDeck.length > 0 },
  // Senba Crow "SS": target a PLAYER (yourself allowed — ruling) who controls a
  // face-up [Hag]; SS this card to THEIR board; then you draw 1.
  "MJG-M03:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "player",
    opponentFilter: (s, pid) => player(s, pid).board.some((b) => faceUp(s, b) && s.instances[b]?.tribes.includes("Hag")) },
  // Senba Crow "Hag Love": SS a [Hag] from your hand; then draw 1.
  "MJG-M03:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat) => player(s, seat).hand.some((h) => (s.instances[h]?.tribes.includes("Hag") ?? false) && M.canSpecialSummon(s.instances[h]?.cardId)) },
  // RUSSIAN "Collusion": target an opponent; COST (pre-colon): discard this card
  // and show your hand to them.
  "MJG-M04:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "opponent" },
  // JOSP "RAWN": discard this card and target a character; place it on the BOTTOM
  // of the discard pile. Offered only when a face-up character exists to target.
  "MJG-M06:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "character",
    canActivate: (s) => s.players.some((p) => !p.eliminated && p.board.some((b) => faceUp(s, b) && s.instances[b]?.cardId !== null)) },
  // El Primer Furry "Slippery Slope": search the deck for a [Furry] -> your hand.
  // Searches are ALWAYS activatable (deck contents are hidden information — the
  // gate must not leak them); the search may resolve without finding.
  "MJG-M07:bottom": { from: "board", speed: "turn", category: "A" },
  // It's Actually Over "Tie the Noose" (At any time): discard this card.
  "MJG-M09:top": { from: "hand", speed: "anytime", category: "S" },
  // NOTE: i'm in your walls "fOUnD mEeEeee" is NOT an activation — it is a triggered
  // hand-trap that chains to an opponent's draw (CARD_TRIGGERS opponentDraw).
  // Famous Fagat "Trap Trick" (At any time): target ANY face-up character; flip it
  // face-down until the end of this turn and SS this card. Offered whenever a face-up
  // character exists to target (characterTargets gates it).
  "MJG-M13:top": { from: "hand", speed: "anytime", category: "S", targets: 1, targetKind: "character" },
  // Famous Fagat "Gay ERP" (Active): target an OPPONENT's character; swap places with
  // it and flip this card face-down until the start of that opponent's next turn.
  "MJG-M13:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "character",
    targetFilter: (s, c, seat) => s.players.some((p) => p.pid !== seat && !p.eliminated && p.board.includes(c)) },
  // Divegrass is Ruined! "CAM ON MJG": target an opponent; SS a (summonable, non-self)
  // hand card to their board and SS this card to yours. Needs a living opponent AND
  // another summonable card in hand to give.
  "MJG-M14:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "opponent",
    canActivate: (s, seat, iid) => living(s).some((p) => p.pid !== seat) &&
      player(s, seat).hand.some((h) => h !== iid && M.canSpecialSummon(s.instances[h]?.cardId)) },
  // Divegrass is Ruined! "SCOR SOM FACKIN MANGANS" (Active): target an opponent who
  // controls a meldable VALUE-1 AND VALUE-3 character; meld them with this card.
  "MJG-M14:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    opponentFilter: (s, pid) => {
      const meldable = (b: string) => faceUp(s, b) && s.instances[b]?.cardId !== null &&
        !s.instances[b]?.protectedFromEffects && !M.isEffectImmune(s, b);
      const bd = player(s, pid).board;
      return bd.some((b) => meldable(b) && M.valueOf(s, b) === 1) && bd.some((b) => meldable(b) && M.valueOf(s, b) === 3);
    } },
  // El Negro Kang "Immigration": SS a [Furry] from the discard pile (public zone —
  // gating on its contents is fine). Needs a summonable Furry there.
  "MJG-M18:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s) => s.discard.some((iid) => (s.instances[iid]?.tribes.includes("Furry") ?? false) && M.canSpecialSummon(s.instances[iid]?.cardId)) },
  // GrinchChads "Game Limit" (At any time): discard this; target EXACTLY 2 opponent
  // characters Special Summoned this turn; shuffle them into the deck.
  "MJG-M10:top": { from: "hand", speed: "anytime", category: "S", targets: 2, targetKind: "character",
    targetFilter: (s, c, seat) => s.instances[c]?.ssThisTurn === true && !(s.players.find((p) => p.pid === seat)?.board.includes(c) ?? false) },
  // GrinchChads "Grinch": draw 2, then shuffle this card into the deck.
  "MJG-M10:bottom": { from: "board", speed: "turn", category: "A" },
  // My /mjg/ Crush "Matchmaker": target 2 OTHER characters (any boards); bond them
  // until the start of your next turn. Needs 2 other characters to exist.
  "MJG-M11:bottom": { from: "board", speed: "turn", category: "A", targets: 2, targetKind: "character",
    targetFilter: (_s, c, _seat, src) => c !== src },
  // RUSSIAN "Target Ron" (Once per game — registry flag): target an opponent; both
  // of you discard a meld. "(You cannot activate this without a meld.)"
  "MJG-M04:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    canActivate: (s, seat) => player(s, seat).meldZone.length > 0 },
  // Justice for Lalatano "ellisa_1.png" (At any time): an effect that DRAWS cards was
  // just activated — chain directly onto it (the top link, not yet resolving). Per the
  // ruling, adding to hand is not drawing (abilityDraws checks the parsed "draw" action).
  "MJG-021:top": { from: "hand", speed: "anytime", category: "S", canActivate: (s) => {
    const top = s.chain[s.chain.length - 1];
    if (!top || (top.step ?? 0) !== 0 || top.negated) return false;
    return abilityDraws(top.effectId);
  } },
  // Justice for Lalatano "Hitsuji ga Ippiki": draw 1, +1 per previous use while in play.
  "MJG-021:bottom": { from: "board", speed: "turn", category: "A" },
  // Bravo "Fake News" (At any time): an OPPONENT just activated a SPELL or ACTIVE —
  // chain directly onto it (ruling: "Must chain to activation"). Triggered PASSIVEs
  // aren't SPELL/ACTIVE activations, so they can't be negated by this.
  "MJG-026:top": { from: "hand", speed: "anytime", category: "S", canActivate: (s, seat) => {
    const top = s.chain[s.chain.length - 1];
    if (!top || (top.step ?? 0) !== 0 || top.negated || top.sourcePlayer === seat) return false;
    const cat = ACTIVATIONS[top.effectId ?? ""]?.category;
    return cat === "S" || cat === "A";
  } },
  // Bravo "Big if True": the reveal-until happens at activation (pre-colon); needs a deck.
  "MJG-026:bottom": { from: "board", speed: "turn", category: "A", canActivate: (s) => s.mainDeck.length > 0 },
  // NEET "Exploiting Lonely Men": target an opponent with NO face-up FEMALE
  // characters on their board, and SS this card; they draw 1, then give a hand card.
  "JONG-030:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "opponent",
    opponentFilter: (s, pid) =>
      !player(s, pid).board.some((b) => faceUp(s, b) && M.cardData(s.instances[b]?.cardId)?.gender === "F") },
  // NEET "Simp": target an opponent; they look at the deck top 3 (privately) and
  // add at least 1 of them to YOUR hand. Needs a deck and an opponent.
  "JONG-030:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    canActivate: (s) => s.mainDeck.length > 0 },
  // Imouto "Onii-chan?": SS a hand card with more ATK, DEF, and VALUE than this
  // character (effective stats — "Stat changes are counted"). Needs one to exist.
  "MJG-031:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat, iid) => player(s, seat).hand.some((h) => strongerThan(s, h, iid)) },
  // Ninjutsu "Ninpo! Triplets no Jutsu!": one of your melds is a NON-KAN triplet.
  "MJG-333:top": { from: "hand", speed: "turn", category: "S",
    canActivate: (s, seat) => player(s, seat).meldZone.some((m) => m.kind === "triplet" && !m.kan) },
  // Shadow Clone: SS a hand card with its effects negated (needs a summonable card).
  "MJG-333:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat) => player(s, seat).hand.some((h) => M.canSpecialSummon(s.instances[h]?.cardId)) },
  // Take your meds "Immunize": target ANOTHER character (any board); it cannot be
  // melded or effect-removed until the start of your next turn.
  "MJG-035:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "character",
    targetFilter: (_s, c, _seat, src) => c !== src },
  // BIG FLAT CAT TATS "*glomp*": draw 1 per [Furry] on any board (itself included,
  // so the count is always >= 1 while it can activate).
  "MJG-0w0:bottom": { from: "board", speed: "turn", category: "A" },
  // Liyuean Opera "Lead Character": a hand card COVERS this character (stunned; returns
  // to hand at end of turn while this stays). Needs a non-Brick hand card — a Brick
  // can't be placed on the board.
  "MJG-045:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat) => player(s, seat).hand.some((h) => !M.isBrick(s.instances[h]?.cardId)) },
  // UNTZ "Deuteragonist": overlay any hand card on this character, and then move
  // all characters to random boards. Needs a hand card.
  // UNTZ "Deuteragonist": a hand card COVERS this character, then everyone scatters.
  // Needs a non-Brick hand card — a Brick can't be placed on the board.
  "MJG-046:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat) => player(s, seat).hand.some((h) => !M.isBrick(s.instances[h]?.cardId)) },
  // YJK "Mojito": SS a 3-ATK card from your hand (needs one to exist).
  "MJG-043:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat) => player(s, seat).hand.some((h) => M.atkOf(s, h) === 3 && M.canSpecialSummon(s.instances[h]?.cardId)) },
  // Ravioli Ravioli "succ": target ANOTHER character with VALUE <= this card's
  // (effective values — Omurice growth counts; ☆ targets are not comparable).
  "MJG-039:top": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "character",
    targetFilter: (s, c, _seat, src) =>
      c !== src && (M.valueOf(s, c) ?? Infinity) <= (M.valueOf(s, src) ?? -Infinity) },
  // Mommy Milkers "From the Source": target ANOTHER character (any board); double
  // its ATK and DEF until the end of this turn.
  "MJG-32歳:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "character",
    targetFilter: (_s, c, _seat, src) => c !== src },
  // G***u "Fatherless Behaviour": target an opponent; up to 3 rounds of the odd/even
  // guessing game (needs a hand card to even start the first pick).
  "MJG-020:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    canActivate: (s, seat) => player(s, seat).hand.length > 0 && living(s).some((p) => p.pid !== seat) },
  // GOTH "Call of Mastema": banish a card in your hand (chosen at resolution);
  // then draw 1. Needs a hand card to banish.
  "MJG-022:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s, seat) => player(s, seat).hand.length > 0 },
  // Gweilo! "Frustrated?": target an opponent; COST (pre-colon): discard this and
  // 2 other hand cards — so the hand needs this + 2 others.
  "MJG-888:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "opponent",
    canActivate: (s, seat) => player(s, seat).hand.filter((x) => !M.isBrick(s.instances[x]?.cardId)).length >= 3 && living(s).some((p) => p.pid !== seat) },
  // Hotwheels "Break a Leg": SS this card by overlaying it on an OPPONENT's
  // character — it arrives on that player's board with the character beneath it.
  "KSG-EMI:top": { from: "hand", speed: "turn", category: "S", targets: 1, targetKind: "character",
    targetFilter: (s, c, seat) => s.players.some((p) => p.pid !== seat && !p.eliminated && p.board.includes(c)) },
  // Gweilo! "Buy Jade": draw 1 from the Faith Deck (needs one to draw).
  "MJG-888:bottom": { from: "board", speed: "turn", category: "A",
    canActivate: (s) => s.faithDeck.length > 0 },
  // Literally Who? "Watson" (Active): target an opponent (with cards); a random card
  // of theirs is picked and you guess its VALUE — correct -> banish it + draw 1.
  "MJG-012:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    canActivate: (s, seat) => living(s).some((p) => p.pid !== seat && p.hand.length > 0) },
  // Koko Doko "So Unlucky" (Active): reveal the top 3 of the deck and special-meld
  // them if valid (else shuffle back). Needs at least 3 cards in the deck.
  "FAT-009:bottom": { from: "board", speed: "turn", category: "A", canActivate: (s) => s.mainDeck.length >= 3 },
  // Adeptchads "A White Hole?" (Active): each player takes the top discard card.
  "MJG-008:top": { from: "board", speed: "turn", category: "A", canActivate: (s) => s.discard.length > 0 },
  // Adeptchads "A Black Hole?" (Active): each player discards all face-up board cards.
  "MJG-008:bottom": { from: "board", speed: "turn", category: "A" },
  // Dnruk "SEX" (Active): target an opponent; pool+shuffle+re-deal both hands.
  // Legal whenever a living opponent exists.
  "MJG-006:bottom": { from: "board", speed: "turn", category: "A", targets: 1, targetKind: "opponent",
    canActivate: (s, seat) => living(s).some((p) => p.pid !== seat) },
  // Yuzu "+1 Image" (At any time): Special Summon this card from hand to any board.
  // The board is CHOSEN on resolution (see RESOLVE_CHOICES), not targeted at
  // activation — so no target is picked when it's activated.
  "MJG-029:top": { from: "hand", speed: "anytime", category: "S" },
  // YUZU GRAPE "Correction" (At any time): target a character with 1 DEF; SS this
  // card, then banish that character. Offered only when such a target exists.
  "MJG-77*:top": { from: "hand", speed: "anytime", category: "S", targets: 1, targetKind: "character",
    targetFilter: (s, iid) => M.defOf(s, iid) === 1 },
  // YUZU GRAPE "Fortune Telling" (Active): look at the top 4 of the deck and return
  // them in any order — the order is chosen on resolution (RESOLVE_CHOICES).
  "MJG-77*:bottom": { from: "board", speed: "turn", category: "A", canActivate: (s) => s.mainDeck.length > 0 },
};

/**
 * Effects that decide at RESOLUTION (PSCT "choose" / "you can"), not at activation —
 * so they can't be responded to and stay hidden until the link resolves. The
 * session prompts the link's controller and writes the pick(s) into the link before
 * it resolves: `choose` is a mandatory pick from candidates (-> script.targets),
 * `optionalPrompt` is a yes/no (-> script.opt), asked in that order.
 */
export const RESOLVE_CHOICES: Record<
  string,
  {
    // hand = a card from the CONTROLLER's own hand (card-click + button);
    // ownOtherBoard = a face-up character the controller controls, other than the source;
    // deck = a SEARCH of the Main deck (contents shown to the chooser only — the
    // searching script must shuffle the deck afterwards)
    choose?: "player" | "discard" | "hand" | "ownOtherBoard" | "deck";
    choosePrompt?: string; // prompt text for the `choose` pick
    chooseLabel?: string; // hand picks: the button label on the clicked card (default "discard")
    // extra candidate constraint for the `choose` pick (state, candidate iid,
    // controller, the link's source iid) — e.g. "with more ATK, DEF, and VALUE"
    chooseFilter?: (state: GameState, iid: string, ctrl: Seat, self: string) => boolean;
    optionalPrompt?: string;
    optShowsHand?: boolean; // the yes/no is answered on a POPUP of the controller's revealed hand (Collusion)
    revealTargetHand?: boolean; // resolution PUBLICLY reveals the targeted player's hand (all players + log) behind a controller confirm popup (We Gottem)
    explosiveAria?: boolean; // pick a hand card, then click a spot on any board — it blows up everything it touches, then itself (Mutsugaki)
    order?: number; // reorder the top N of the deck (controller)
    orderHand?: string; // the controller orders their WHOLE HAND (prompt text) — the chosen order becomes the discard order (Ashes)
    guess?: boolean; // a value-guess vs a random card from the targeted opponent's hand (Watson)
    optBy?: "controller" | "target"; // who answers the yes/no (default: controller)
    bellyDance?: boolean; // copy a chosen controlled character's Active (its role/targets gathered at resolution)
    classCard?: boolean; // reveal a hand card with an Active, copy that Active (Belly machinery), then attach it as an overlay (Strawberry Cup)
    parity?: boolean; // the odd/even guessing game vs the targeted opponent (G***u)
    theirHand?: boolean; // the controller picks 1 card from the TARGETED player's hand (revealed to the controller only)
    // pick `count` cards (one at a time) from a player's hand right BEFORE step
    // `atStep` resolves — so cards just drawn in earlier steps are pickable. Picks
    // append to the link's targets after the activation targets. `by` says whose
    // hand (and who picks); `label` is the hand-pick button verb. `filter` (state,
    // hand-card iid, the link's source iid) constrains which cards are offered.
    handAtStep?: { atStep: number; count: number; by: "controller" | "target"; label: string; prompt: string;
      filter?: (state: GameState, iid: string, self: string) => boolean };
    simp?: boolean; // the TARGET looks at the deck top 3 (privately) and gives >=1 to the controller (NEET)
    succ?: boolean; // attach the target as an overlay, then optionally repeat with a fresh pick (Ravioli)
    // the controller picks a NUMBER at resolution, written into the link's targets
    // for the script (Pon Yeehaw's "any ℕ")
    pickValue?: { min: number; max: number; prompt: string };
    // The Usual?: the TARGET picks 1 of the revealed cards (targets[1..]); the link
    // is reordered to [seat, pick, ...rest] for the script
    usual?: boolean;
    // Target Ron: the controller then the target each pick one of their own melds
    // to discard (indexes appended to targets as strings; "-1" = no meld)
    meldDiscard?: boolean;
    // LTG (Hanana): the targeted opponent (targets[0]) chooses one of THEIR board cards
    // to discard; the pick is appended to targets ("-1" if their board is empty).
    targetBoardDiscard?: boolean;
    // Solem (No): at step 0 the controller chooses one of THEIR melds to discard (the
    // cost); the meld index is appended to targets ("-1" if none).
    ownMeldDiscard?: boolean;
    // TSUOM: each opponent (anticlockwise) chooses 1 hand card to discard
    tsuom?: boolean;
    // Beautification Council: EVERY player (anticlockwise from the controller) discards
    // floor(hand/2) cards of their own choice.
    halfDiscard?: boolean;
    // Treasurer: when the 2 revealed cards' VALUEs sum to 7, players with MORE THAN 7
    // cards in hand discard half (the 6/8 add-to-hand and shuffle-back are in the script).
    treasurerDiscard?: boolean;
    // Secret Rumors: the TARGET (targets[0]) blindly picks 1 of the 2 placed face-down
    // cards (targets[1..2]) to take; the pick is APPENDED to targets for the script.
    secretMove?: boolean;
    // Breast Expansion: at step 1 the controller chooses the draw mode ("fill" = draw
    // until 5 in hand, "two" = draw 2), written into targets[0].
    breastExpansion?: boolean;
    // Haitei Raoyue: optionally meld the drawn card (targets[0]) with 2 cards from your
    // board / the discard top (a guided 2-pick); picks append to targets.
    haitei?: boolean;
    // Futuristic Player: the controller looks at the top 3 of the deck (private) and
    // picks 1 to add to hand (-> targets[0]); the other 2 stay on top in order.
    peekTop?: boolean;
    // Call Slut: pick 1 of your board/hand cards that completes a Special Meld with the
    // opponent's discarded card (targets[0]) + this card; the pick appends to targets.
    callSlut?: boolean;
  }
> = {
  "MJG-015:bottom": { bellyDance: true }, // Good Morning Sirs! "Belly Dance"
  "MJG-C23:bottom": { classCard: true }, // Strawberry Cup "Class Card" (borrow a hand card's Active + attach it)
  // Vanilla Cup "Holy Grail": after the attach cost, SEARCH the deck for any card to Special
  // Summon (the script SS's the pick and shuffles the deck).
  "MJG-C24:bottom": { choose: "deck", choosePrompt: "Holy Grail — search the deck for any card to Special Summon" },
  "MJG-020:bottom": { parity: true }, // G***u: the odd/even guessing game (up to 3 rounds)
  // GOTH "Call of Mastema": choose (at resolution) a card from your own hand to banish.
  "MJG-022:bottom": { choose: "hand", choosePrompt: "Call of Mastema — banish 1 card from your hand", chooseLabel: "banish" },
  // Gweilo! "Frustrated?": look at the targeted opponent's hand (controller-private)
  // and add 1 card from it to your hand.
  "MJG-888:top": { theirHand: true },
  // Hotwheels "Trolley Problem": choose the other character you control to take
  // along to the shimocha's board ("(if any)" — no candidates -> it goes alone).
  "KSG-EMI:bottom": { choose: "ownOtherBoard", choosePrompt: "Trolley Problem — choose a character to take along" },
  // NEET top: after their draw (step 1), the target chooses a hand card to give.
  "JONG-030:top": { handAtStep: { atStep: 2, count: 1, by: "target", label: "give", prompt: "Choose a card from your hand to give to the activator" } },
  // Ninjutsu: after drawing 3 (step 1), the controller picks 3 cards to shuffle back.
  "MJG-333:top": { handAtStep: { atStep: 2, count: 3, by: "controller", label: "shuffle", prompt: "Shuffle 3 cards from your hand into the deck — pick them" } },
  // CAM ON MJG: pick a (summonable, non-self) hand card to give to the opponent —
  // gathered before the atomic resolution (step 0) and appended after the opponent.
  "MJG-M14:top": { handAtStep: { atStep: 0, count: 1, by: "controller", label: "summon",
    prompt: "CAM ON MJG — Special Summon a card from your hand to the opponent's board",
    filter: (s, iid, self) => iid !== self && M.canSpecialSummon(s.instances[iid]?.cardId) } },
  // Shadow Clone: pick the hand card to Special Summon with its effects negated.
  "MJG-333:bottom": { choose: "hand", chooseLabel: "summon",
    chooseFilter: (s, iid) => M.canSpecialSummon(s.instances[iid]?.cardId),
    choosePrompt: "Shadow Clone — Special Summon a hand card (its effects are negated)" },
  // Liyuean Opera "Lead Character": pick the hand card that covers it (no Bricks —
  // a Brick can't be placed on the board).
  "MJG-045:bottom": { choose: "hand", chooseLabel: "overlay",
    chooseFilter: (s, iid) => !M.isBrick(s.instances[iid]?.cardId),
    choosePrompt: "Lead Character — overlay a hand card ON TOP of this character (stunned; returns to your hand at the end of your turn)" },
  // UNTZ "Deuteragonist": pick the hand card to overlay before the scramble.
  "MJG-046:bottom": { choose: "hand", chooseLabel: "overlay",
    chooseFilter: (s, iid) => !M.isBrick(s.instances[iid]?.cardId),
    choosePrompt: "Deuteragonist — overlay a hand card ON TOP of this character, then everyone moves" },
  // YJK "Mojito": pick the 3-ATK hand card to Special Summon.
  "MJG-043:bottom": { choose: "hand", chooseLabel: "summon",
    chooseFilter: (s, iid) => M.atkOf(s, iid) === 3 && M.canSpecialSummon(s.instances[iid]?.cardId),
    choosePrompt: "Mojito — Special Summon a 3 ATK card from your hand" },
  // Imouto "Onii-chan?": pick the hand card to Special Summon — only cards with
  // more ATK, DEF, and VALUE than this character qualify.
  "MJG-031:bottom": { choose: "hand", chooseLabel: "summon",
    chooseFilter: (s, iid, _ctrl, self) => strongerThan(s, iid, self),
    choosePrompt: "Onii-chan? — Special Summon a card stronger than this character" },
  // NEET bottom: the target looks at the deck top 3 and gives at least 1.
  "JONG-030:bottom": { simp: true },
  // Ravioli "succ": attach the target; then you can repeat (fresh pick each round,
  // re-filtered against the GROWN value).
  "MJG-039:top": { succ: true },
  // Pon Yeehaw "Black or White": choose its new VALUE — "any ℕ number" (UI-bounded).
  "MJG-044:top": { pickValue: { min: 1, max: 999, prompt: "Black or White — choose this card's new VALUE (any ℕ)" } },
  // The Usual?: the targeted opponent picks 1 of the revealed 3.
  "MJG-M02:bottom": { usual: true },
  // Hag Love: pick the [Hag] hand card to Special Summon.
  "MJG-M03:bottom": { choose: "hand", chooseLabel: "summon",
    chooseFilter: (s, iid) => (s.instances[iid]?.tribes.includes("Hag") ?? false) && M.canSpecialSummon(s.instances[iid]?.cardId),
    choosePrompt: "Hag Love — Special Summon a [Hag] from your hand" },
  // Collusion: the targeted opponent decides whether to show their hand back.
  "MJG-M04:top": { optBy: "target", optShowsHand: true, optionalPrompt: "Show your hand back? (both of you draw 3)" },
  // Target Ron: each side picks one of their own melds to discard.
  "MJG-M04:bottom": { meldDiscard: true },
  // LTG: the targeted opponent chooses a board card to discard (then you SS this card).
  "MJG-C32:top": { targetBoardDiscard: true },
  // Solem: at step 0 the controller discards one of their melds (the cost).
  "MJG-C34:top": { ownMeldDiscard: true },
  // TSUOM: each opponent chooses 1 hand card to discard, anticlockwise.
  "MJG-M06:bottom": { tsuom: true },
  // Beautification Council: every player discards half their hand, anticlockwise.
  "MJG-C12:top": { halfDiscard: true },
  // Treasurer: on a revealed sum of 7, hand>7 players discard half.
  "MJG-C17:bottom": { treasurerDiscard: true },
  // Secret Rumors: the targeted opponent blindly takes one of the 2 face-down cards.
  "MJG-M22:bottom": { secretMove: true },
  // Breast Expansion: choose to draw until 5 in hand, or draw 2.
  "SOA-C02:top": { breastExpansion: true },
  // Haitei Raoyue: optionally meld the drawn card with 2 board/discard-top cards.
  "MJG-C03:bottom": { haitei: true },
  // Futuristic Player: look at the top 3 and add 1 to your hand.
  "MJG-C05:bottom": { peekTop: true },
  // Call Slut: pick a card to complete the Special Meld with the opponent's discard.
  "MJG-C06:top": { callSlut: true },
  // Buying gf: pick 2 of your hand cards to give to the FEMALE's owner (before the
  // single resolution step that gives them and takes control).
  "MJG-M23:bottom": { handAtStep: { atStep: 0, count: 2, by: "controller", label: "give",
    prompt: "Buying gf — give 2 cards from your hand to the character's owner" } },
  // Slippery Slope: search the deck for a [Furry] (shuffles afterwards).
  "MJG-M07:bottom": { choose: "deck",
    chooseFilter: (s, iid) => s.instances[iid]?.tribes.includes("Furry") ?? false,
    choosePrompt: "Slippery Slope — search the deck for a [Furry]" },
  // Immigration: choose a [Furry] in the discard pile to Special Summon.
  // Flow Book 1 "We Gottem": the targeted player's hand is revealed to EVERYONE
  // (and logged) with a confirm popup for the controller before the grab.
  "MJG-M19:bottom": { revealTargetHand: true },
  // Mutsugaki "Explosive Aria": hand pick + board-click placement at resolution.
  "MSGK-C30:bottom": { explosiveAria: true },
  "MJG-M18:bottom": { choose: "discard",
    chooseFilter: (s, iid) => (s.instances[iid]?.tribes.includes("Furry") ?? false) && M.canSpecialSummon(s.instances[iid]?.cardId),
    choosePrompt: "Immigration — Special Summon a [Furry] from the discard pile" },
  "MJG-029:top": { choose: "player" }, // Yuzu: choose any board (a player) on resolution
  // TO Here bottom: choose a discarded card, then optionally return TO Here to hand.
  "AS4-PIN:bottom": { choose: "discard", optionalPrompt: "Return this card to your hand?" },
  // YUZU GRAPE bottom: look at the top 4 of the deck and return them in any order.
  "MJG-77*:bottom": { order: 4 },
  // Resplendent Phoenix "Ashes": the controller picks the order their hand is discarded
  // (first chosen is discarded first; the last ends up on top of the pile).
  "MJG-042:top": { orderHand: "Ashes — order your hand for the discard (first = discarded first, last ends up on top)" },
};

/**
 * Decisions made at ACTIVATION (everything before the PSCT colon `:` is an
 * activation condition — R6/R42 — determined when the card is activated and NOT
 * responded to). The session resolves these before the effect is placed on the
 * chain, baking the outcome into the link's targets/opt; opponents then respond
 * only to the resulting post-colon effect.
 */
export const ACTIVATION_CHOICES: Record<
  string,
  {
    guess?: boolean;
    redeem?: boolean;
    discardCost?: number;
    // Faith-summon COST (Anon's Mom "Art"): discard cards from hand/board whose DEF totals
    // EXACTLY this number, picked one at a time (only choices that keep a valid total open).
    // An object form (Knot) requires the discards to total EXACTLY the given ATK AND/OR DEF.
    faithCost?: number | { atk?: number; def?: number; anyBoard?: boolean }; // anyBoard: opponents' face-up board cards are valid cost material (Knot)
    // Faith-summon COST (ما شاء الله): discard ONE card from hand/board whose ATK, DEF, or
    // VALUE equals the given number (whichever stats are specified).
    faithTribute?: { atk?: number; def?: number; value?: number };
    // Resurrection COST: discard N cards from your hand (the activating card is NOT in the
    // hand — it is in the discard pile, being summoned).
    handCost?: number;
    // Depths of Hell COST: banish N OTHER cards from your hand (the activating card is not
    // banished — it is being Special Summoned).
    banishHandCost?: number;
    // Holy Grail COST: attach ONE non-effect character from your hand or board to this card
    // as an overlay (picked at activation).
    attachNonEffect?: boolean;
    // De-Fusion: discard this card, then choose up to `max` copies of `cardId` from your hand,
    // the deck, or the discard pile to Special Summon (picked at activation).
    deFusion?: { cardId: string; max: number };
    // Explosive Aria (Mutsugaki): place a hand card at a chosen gap in any player's ordered
    // board; discard the (<=2) cards flanking that gap, then the placed card. Picked at activation.
    // June 4th Incident: pick a Main Deck card whose serial code is formable from this card +
    // 2 hand cards (the pair is auto-revealed). Picked at activation.
    serialCode?: boolean;
    // Catbox "Upload": pick a non-Faith hand card (with an ACTIVE) to place in the Extra Zone
    // alongside this card. Picked at activation.
    upload?: boolean;
    // 9 Tailed Fox COST: shuffle exactly the top N cards of the discard pile into the deck
    // (automatic — no decision).
    shuffleDiscardTop?: number;
    // A Worthy Disciple (Crimson Chemist): a modal — choose up to 3 different effects (each
    // possibly with a value/target sub-pick), gathered one at a time at activation.
    disciple?: boolean;
    // pre-colon "reveal from the deck top until N cards with VALUE >= min": runs at
    // activation (public, no decision); the hits become the link's targets.
    excavate?: { count: number; minValue: number };
    // pre-colon "reveal the top N of the deck": logged publicly at activation; the
    // revealed cards are APPENDED to the link's targets (after any activation targets).
    revealTop?: number;
    // Collusion's pre-colon COST: discard this card and show your hand to the target.
    collude?: boolean;
    // Secret Rumors' pre-colon COST: place N hand cards face-down on your board; the
    // placed iids are APPENDED to the link's targets (after the activation targets).
    placeFaceDownCost?: number;
    // Haitei Raoyue's pre-colon: reveal and draw the BOTTOM card of the Main deck; the
    // drawn card's iid becomes the link's targets[0] (the forced meld material).
    drawBottom?: boolean;
    // Log Review's pre-colon: reveal the top card (-> targets[0]); set link.opt iff it
    // could meld with 2 of your face-up board cards.
    logReview?: boolean;
    // Honest Gamble's pre-colon: the targeted opponent reveals a random hand card and
    // the activator reveals a random hand card -> targets [oppSeat, oppCard, myCard].
    honestGamble?: boolean;
    // Honestest Gamble's pre-colon: as honestGamble, but each player CHOOSES which hand
    // card to reveal (opponent first, then the activator) -> [oppSeat, oppCard, myCard].
    honestestGamble?: boolean;
  }
> = {
  // Literally Who? "Watson": pick a random card from the targeted opponent's hand,
  // guess its VALUE; if correct, the post-colon effect banishes it (+ you draw 1).
  "MJG-012:bottom": { guess: true },
  // Good Morning Sirs! "iTunes Gift Card": the targeted opponent decides to redeem.
  "MJG-015:top": { redeem: true },
  // Gweilo! "Frustrated?": the pre-colon COST — discard this card and N=2 OTHER
  // hand cards (picked via the hand-click UI) before the effect is chained.
  "MJG-888:top": { discardCost: 2 },
  // Anon's Mom "Art": the Faith-summon COST — discard cards totaling exactly 7 DEF.
  "MJG-014:top": { faithCost: 7 },
  // Knot: the Faith-summon COST — discard cards totaling exactly 6 ATK and 9 DEF.
  "MJG-WAN:top": { faithCost: { atk: 6, def: 9, anyBoard: true } },
  // Tra: the Faith-summon COST — discard cards totaling exactly 7 ATK.
  "MJG-410:top": { faithCost: { atk: 7 } },
  // ما شاء الله: the Faith-summon COST — discard one card with 7 ATK, 8 DEF, or 6 VALUE.
  "MJG-016:top": { faithTribute: { atk: 7, def: 8, value: 6 } },
  // HOLY MAHJONG "Resurrection": discard 3 hand cards to Special Summon it from the discard.
  "MJG-025:top": { handCost: 3 },
  // Magical Sands "Depths of Hell": banish 6 other hand cards to Special Summon it.
  "MJG-C13:top": { banishHandCost: 6 },
  // Vanilla Cup "Holy Grail": the COST — attach a non-effect character (hand/board) as an overlay.
  "MJG-C24:bottom": { attachNonEffect: true },
  // De-Fusion: discard this card, then Special Summon up to 3 "Blue-Eyes White Dragon".
  "MJG-C18:bottom": { deFusion: { cardId: "LOB-001", max: 3 } },
  // June 4th Incident: search the Main Deck by serial code (formed from this + 2 hand cards).
  "MJG-117633:top": { serialCode: true },
  // Catbox: pick the non-Faith card (with an Active) to upload to the Extra Zone.
  "NYA-999:top": { upload: true },
  // 9 Tailed Fox: the Faith-summon COST — shuffle the top 9 of the discard into the deck.
  "MJG-036:top": { shuffleDiscardTop: 9 },
  // A Worthy Disciple: the modal — choose up to 3 different effects at activation.
  "MJG-040:top": { disciple: true },
  // Bravo "Big if True": reveal from the deck top until two VALUE-4+ cards.
  "MJG-026:bottom": { excavate: { count: 2, minValue: 4 } },
  // The Usual?: reveal the top 3 of the deck at activation.
  "MJG-M02:bottom": { revealTop: 3 },
  // Treasurer: reveal the top 2 at activation (-> targets[0..1]); the script sums them.
  "MJG-C17:bottom": { revealTop: 2 },
  // Collusion: discard this card and show your hand to the targeted opponent.
  "MJG-M04:top": { collude: true },
  // Majsoul Secret Room "Secret Rumors": place 2 hand cards face-down on your board.
  "MJG-M22:bottom": { placeFaceDownCost: 2 },
  // amaekoromo "Haitei Raoyue": reveal & draw the bottom card of the deck (-> targets[0]).
  "MJG-C03:bottom": { drawBottom: true },
  // Copebots "Log Review": reveal the top card; opt = could meld with 2 board cards.
  "MJG-C06:bottom": { logReview: true },
  // Honest Gamble / Honester Gamble: both reveal a random hand card (target, oppCard, myCard).
  "MJG-C09:bottom": { honestGamble: true },
  "MJG-C10:bottom": { honestGamble: true },
  // Honestest Gamble: both CHOOSE a hand card to reveal (target, oppCard, myCard).
  "MJG-C11:bottom": { honestestGamble: true },
  // Double or Nothing: both reveal a random hand card (target, oppCard, myCard).
  "MJG-C12:bottom": { honestGamble: true },
};

export type LegalAction =
  | { kind: "draw" }
  | { kind: "endTurn" }
  | { kind: "advance" }
  | { kind: "discard"; iid: string }
  | { kind: "normalSummon"; iid: string }
  | { kind: "attack"; iid: string } // attacker; target chosen by the player
  | { kind: "meld" } // a normal meld is possible; materials chosen by the player
  | { kind: "kan"; meldIndex: number; materialIds: string[] } // add a matching 4th card to this non-KAN triplet
  | { kind: "activate"; iid: string; role: string; from: "hand" | "board" | "discard"; speed: "turn" | "anytime"; targets: number; targetKind?: "character" | "discard" | "opponent" | "player"; targetIds?: string[]; targetSeats?: Seat[]; category?: "S" | "A" | "F"; handMeld?: boolean; as?: string };

const cardIdOf = (s: GameState, iid: string) => s.instances[iid]?.cardId ?? "";

// Faith-deck card ids (mirrors manifest.json's deck === "Faith"). Used by Catbox "Upload":
// you may only upload a card that is NOT a Faith-deck card (and that has an ACTIVE).
export const FAITH_DECK = new Set([
  "MJG-000", "MJG-014", "MJG-016", "MJG-025", "MJG-027", "MJG-036", "MJG-040", "MJG-042", "MJG-048",
  "MJG-117633", "MJG-410", "MJG-C13", "MJG-C14", "MJG-C18", "MJG-C21", "MJG-C22", "MJG-C23", "MJG-C24",
  "MJG-C25", "MJG-C26", "MJG-CC", "MJG-M05", "MJG-WAN", "MJG-ZERO", "MTG-001", "NYA-001", "NYA-999", "SHA-001",
]);
/** Catbox "Upload": a hand card is uploadable if it is NOT a Faith-deck card and has an ACTIVE. */
export function isUploadable(cardId: string): boolean {
  return cardId !== "" && !FAITH_DECK.has(cardId) && activeRoles(cardId).length > 0;
}

// ---- "June 4th Incident" (MJG-117633) serial-code search -------------------
/** The serial code = the segment of a card id AFTER the first hyphen (MJG-001 -> "001",
 *  MSGK-C30 -> "C30"). */
export function idCode(cardId: string): string {
  const i = cardId.indexOf("-");
  return i < 0 ? cardId : cardId.slice(i + 1);
}
/** The character a revealed card contributes: "*" (wild — any digit OR letter) for June 4th
 *  itself or a ☆ (null-VALUE) card, else its printed VALUE as a string. */
function serialChar(state: GameState, iid: string): string {
  const ci = state.instances[iid];
  if (!ci || ci.cardId === "MJG-117633" || ci.value === null) return "*";
  return String(ci.value);
}
/** Can the per-card chars (one per revealed card; "*" = wild) form `code` via a bijection? */
function canFormCode(code: string, chars: string[]): boolean {
  if (code.length !== chars.length) return false;
  const used = chars.map(() => false);
  const rec = (pos: number): boolean => {
    if (pos === code.length) return true;
    for (let i = 0; i < chars.length; i++) {
      if (!used[i] && (chars[i] === "*" || chars[i] === code[pos])) {
        used[i] = true;
        if (rec(pos + 1)) return true;
        used[i] = false;
      }
    }
    return false;
  };
  return rec(0);
}
/** True if `deckIid`'s serial code is formable from June 4th (always wild) + some 2 of `others`
 *  (the other hand cards). Only 3-character codes can be made (this card + 2 others). */
export function serialFormable(state: GameState, others: readonly string[], deckIid: string): boolean {
  return serialPairFor(state, others, deckIid) !== null;
}
/** A concrete pair from `others` (with June 4th as the third, wild) that forms `deckIid`'s code,
 *  or null. Used both to gate the search and to reveal the cards. */
export function serialPairFor(state: GameState, others: readonly string[], deckIid: string): [string, string] | null {
  const code = idCode(state.instances[deckIid]?.cardId ?? "");
  if (code.length !== 3) return null;
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) {
      if (canFormCode(code, ["*", serialChar(state, others[i]!), serialChar(state, others[j]!)])) return [others[i]!, others[j]!];
    }
  }
  return null;
}
/** The hand cards viable as the NEXT reveal for `deckIid`'s code, given the reveals already
 *  `picked` (June 4th itself is always the wild third). picked=[] -> first-pick candidates
 *  (those with SOME completing partner); picked=[h1] -> the partners completing with h1. */
export function serialPicks(state: GameState, others: readonly string[], deckIid: string, picked: readonly string[]): string[] {
  const code = idCode(state.instances[deckIid]?.cardId ?? "");
  if (code.length !== 3) return [];
  const rest = others.filter((h) => !picked.includes(h));
  if (picked.length === 0)
    return rest.filter((h1) => rest.some((h2) => h2 !== h1 && canFormCode(code, ["*", serialChar(state, h1), serialChar(state, h2)])));
  if (picked.length === 1)
    return rest.filter((h2) => canFormCode(code, ["*", serialChar(state, picked[0]!), serialChar(state, h2)]));
  return [];
}

/** Roles of a card whose ACTIVE ability (board Active) Belly Dance can copy (top or
 *  bottom) — including `handMeld` Actives (>dama), resolved via a meld-from-hand pick. */
export function activeRoles(cardId: string): ("top" | "bottom")[] {
  return (["top", "bottom"] as const).filter((r) => {
    const spec = ACTIVATIONS[`${cardId}:${r}`];
    return spec?.category === "A" && spec.from === "board";
  });
}

/** All face-up characters on any living player's board (the default "character"
 *  target pool), optionally narrowed by an ActivationSpec.targetFilter. `seat` and
 *  `source` (the activating card) are passed through for filters that need them. */
export function characterTargets(
  state: GameState,
  filter?: (s: GameState, iid: string, seat: Seat, source: string) => boolean,
  seat: Seat = -1 as Seat,
  source = "",
): string[] {
  const out: string[] = [];
  for (const p of state.players) {
    if (p.eliminated) continue;
    // SOA (Temeraire): an opponent cannot target a SOA player's cards.
    if (p.pid !== seat && M.soaImmune(state, p.pid)) continue;
    for (const b of p.board) {
      if (!faceUp(state, b) || state.instances[b]?.cardId === null) continue;
      if (filter && !filter(state, b, seat, source)) continue;
      out.push(b);
    }
  }
  return out;
}

/** Activatable abilities of a card at `where`, filtered by speed and condition. */
function activations(
  state: GameState,
  seat: Seat,
  iid: string,
  where: "hand" | "board" | "discard",
  speeds: ("turn" | "anytime")[],
): LegalAction[] {
  const ownCardId = cardIdOf(state, iid);
  const out: LegalAction[] = [];
  if (M.isEffectNegated(state, iid)) return out; // effects negated (Shadow Clone / Antipsychotics) — nothing activatable
  // a card's own cardId, plus any it gains via Twin Personality (MJG-C25); granted Actives are
  // tagged with `as` (their granting cardId) so the activation flow keys off the right ability.
  const cardIds = M.abilityCardIds(state, iid);
  for (const cardId of cardIds) {
   const as = cardId === ownCardId ? undefined : cardId;
   for (const role of ["top", "bottom"] as const) {
    const eid = `${cardId}:${role}`;
    const spec = ACTIVATIONS[eid];
    if (!spec || spec.from !== where || !speeds.includes(spec.speed)) continue;
    // a tapped or STUNNED card can no longer use an on-board ACTIVE
    if (spec.from === "board" && (state.instances[iid]?.tapped || state.instances[iid]?.stunned)) continue;
    // an effect already on the stack (announced, not yet resolved) can't be re-activated
    if (state.chain.some((l) => l.script?.self === iid && l.script?.role === role && l.script?.cardId === cardId)) continue;
    // SPELL/ACTIVE lock auras (and "no reveal effects" — Malware)
    if (checkRestrictions(state, { kind: "activate", player: seat, abilityType: spec.category, effectId: eid, from: spec.from })) continue;
    if (spec.canActivate && !spec.canActivate(state, seat, iid)) continue;
    // once-per-turn / once-per-game cap — PER CARD NAME: a granted (Twin Personality)
    // ability tracks under the HOST card's name, independent of the granting card's use.
    const ab = M.ability(eid);
    if (ab && !canActivateOnce(ab, as !== undefined ? `${ownCardId}>${eid}` : eid, seat, state.usage)) continue;
    // character targets are precomputed (the single source of truth for client
    // highlighting + server validation); if not enough valid ones exist, the
    // effect can't target -> don't offer it.
    let targetIds: string[] | undefined;
    if (spec.targetKind === "character" && (spec.targets ?? 0) > 0) {
      targetIds = spec.targetFaceDown
        ? state.players.flatMap((p) => (p.eliminated ? [] : p.board.filter((b) => state.instances[b]?.faceDown)))
        : characterTargets(state, spec.targetFilter, seat, iid);
      if (targetIds.length < (spec.targets ?? 0)) continue;
    }
    let targetSeats: Seat[] | undefined;
    if ((spec.targetKind === "opponent" || spec.targetKind === "player") && (spec.targets ?? 0) > 0) {
      targetSeats = living(state)
        // SOA (Temeraire): an opponent cannot target the SOA player themselves.
        .filter((p) => (spec.targetKind === "player" || p.pid !== seat) && !(p.pid !== seat && M.soaImmune(state, p.pid)) && (!spec.opponentFilter || spec.opponentFilter(state, p.pid, seat)))
        .map((p) => p.pid);
      if (targetSeats.length < (spec.targets ?? 0)) continue; // no legal seat -> not offered
    }
    out.push({ kind: "activate", iid, role, from: spec.from, speed: spec.speed, targets: spec.targets ?? 0, targetKind: spec.targetKind, targetIds, targetSeats, category: spec.category, handMeld: spec.handMeld, ...(as !== undefined ? { as } : {}) });
   }
  }
  return out;
}

/**
 * True if `seat` could start a normal meld now: not yet melded this turn, not
 * restricted, and some 3 of its meld sources (own face-up board + discard top)
 * form a valid meld. The exact materials are chosen client-side (the selection
 * UI only lets you pick cards that keep a valid meld reachable).
 */
function meldPossible(state: GameState, seat: Seat): boolean {
  const me = player(state, seat);
  // Animal Tamer (YJK): after the normal meld is used, a meld with >=1 [Furry]
  // material still counts as a Special Meld — keep offering those combinations.
  const tamerOnly = me.meldedThisTurn;
  if (tamerOnly && !me.board.some((b) => faceUp(state, b) && M.hasAbility(state, b, "MJG-043") && !M.isEffectNegated(state, b))) return false;
  if (checkRestrictions(state, { kind: "meld", player: seat }) !== null) return false;
  // a "cannot be melded" card (Malware) can't be a material -> not a meld source
  const sources = me.board.filter((b) => faceUp(state, b) && !M.cannotBeMelded(state, b));
  if (state.discard[0]) sources.push(state.discard[0]);
  if (sources.length < 3) return false;
  const vals = sources.map((iid) => M.valueOf(state, iid));
  const furry = sources.map((iid) => state.instances[iid]?.tribes.includes("Furry") ?? false);
  for (let i = 0; i < vals.length - 2; i++)
    for (let j = i + 1; j < vals.length - 1; j++)
      for (let k = j + 1; k < vals.length; k++)
        if (M.meldKind([vals[i]!, vals[j]!, vals[k]!]) !== null && (!tamerOnly || furry[i] || furry[j] || furry[k])) return true;
  return false;
}

/** True if any opponent has a face-up board card (a legal attack target exists). */
function hasOpponentTarget(state: GameState, seat: Seat): boolean {
  return state.players.some(
    (p) => p.pid !== seat && !p.eliminated && p.board.some((b) => !state.instances[b]?.faceDown && !M.cannotBeAttacked(state, b)),
  );
}

/** Catbox "Upload": each uploaded card in the Extra Zone exposes its ACTIVE(s) to the active
 *  player, once per turn (the per-turn-per-player limit rides the once_per_turn usage bucket).
 *  Targets are precomputed relative to the USING player, exactly like a board Active. */
function extraActivations(state: GameState, seat: Seat): LegalAction[] {
  const out: LegalAction[] = [];
  for (const u of state.extraZone) {
    const ucid = cardIdOf(state, u);
    for (const role of activeRoles(ucid)) {
      const eid = `${ucid}:${role}`;
      const spec = ACTIVATIONS[eid]!;
      if ((state.usage["once_per_turn"]?.[`EXTRA ${u}:${role} ${seat}`] ?? 0) > 0) continue; // used by this player this turn
      if (checkRestrictions(state, { kind: "activate", player: seat, abilityType: spec.category, effectId: eid, from: spec.from })) continue;
      if (spec.canActivate && !spec.canActivate(state, seat, u)) continue;
      let targetIds: string[] | undefined;
      if (spec.targetKind === "character" && (spec.targets ?? 0) > 0) {
        targetIds = spec.targetFaceDown
          ? state.players.flatMap((p) => (p.eliminated ? [] : p.board.filter((b) => state.instances[b]?.faceDown)))
          : characterTargets(state, spec.targetFilter, seat, u);
        if (targetIds.length < (spec.targets ?? 0)) continue;
      }
      let targetSeats: Seat[] | undefined;
      if ((spec.targetKind === "opponent" || spec.targetKind === "player") && (spec.targets ?? 0) > 0) {
        targetSeats = living(state)
          .filter((p) => (spec.targetKind === "player" || p.pid !== seat) && !(p.pid !== seat && M.soaImmune(state, p.pid)) && (!spec.opponentFilter || spec.opponentFilter(state, p.pid, seat)))
          .map((p) => p.pid);
        if (targetSeats.length < (spec.targets ?? 0)) continue;
      }
      out.push({ kind: "activate", iid: u, role, from: spec.from, speed: spec.speed, targets: spec.targets ?? 0, targetKind: spec.targetKind, targetIds, targetSeats, category: spec.category, handMeld: spec.handMeld });
    }
  }
  return out;
}

/** All currently-legal actions for `seat`. */
export function legalActions(state: GameState, seat: Seat): LegalAction[] {
  if (state.winner !== null || state.phase === M.Phase.GAME_OVER) return [];
  const me = state.players.find((p) => p.pid === seat);
  if (!me || me.eliminated) return [];
  const out: LegalAction[] = [];
  const isTurn = state.activePlayer === seat;

  if (isTurn && state.phase === M.Phase.TURN_START_DRAW) out.push({ kind: "draw" });
  if (isTurn && state.phase === M.Phase.TURN_END) out.push({ kind: "advance" });
  // hand-size discard: The Brick ([B]) cannot be discarded from the hand, so it is not a choice
  if (isTurn && state.phase === M.Phase.DISCARD_DOWN)
    for (const iid of me.hand) if (!M.isBrick(state.instances[iid]?.cardId)) out.push({ kind: "discard", iid });
  // forced board discard (FAQ §9): the current owner discards their queued cards
  // one at a time (their chosen order), even off-turn.
  if (state.phase === M.Phase.FORCED_DISCARD) {
    const g = state.pendingForcedDiscards[0];
    if (g && g.player === seat) for (const iid of g.iids) if (me.board.includes(iid)) out.push({ kind: "discard", iid });
  }

  if (isTurn && state.phase === M.Phase.MAIN_PHASE) {
    out.push({ kind: "endTurn" });
    for (const iid of me.hand) {
      // "Ashes" lets all players Normal Summon any number of times (ignore summonedThisTurn)
      if ((!me.summonedThisTurn || state.unlimitedSummon !== null) && M.canNormalSummon(cardIdOf(state, iid)) && checkRestrictions(state, { kind: "summon", player: seat }) === null) out.push({ kind: "normalSummon", iid });
      // on your own turn you may also use quick (anytime) effects from hand
      out.push(...activations(state, seat, iid, "hand", ["turn", "anytime"]));
    }
    const target = hasOpponentTarget(state, seat);
    const attackBlocked = checkRestrictions(state, { kind: "attack", player: seat }) !== null;
    for (const iid of me.board) {
      const ci = state.instances[iid];
      if (ci && !ci.faceDown && !ci.tapped && !ci.stunned && !M.cannotAttack(state, iid) && target && !attackBlocked) out.push({ kind: "attack", iid });
      out.push(...activations(state, seat, iid, "board", ["turn", "anytime"]));
    }
    // the current player may activate effects on cards IN THE DISCARD pile (Resurrection)
    for (const iid of state.discard) out.push(...activations(state, seat, iid, "discard", ["turn", "anytime"]));
    // Catbox: the active player may use each uploaded card's ACTIVE once this turn (Extra Zone)
    out.push(...extraActivations(state, seat));
    if (meldPossible(state, seat)) out.push({ kind: "meld" });
    // KAN: extend a non-KAN TRIPLET meld with a matching 4th card. Mirrors resolveKan's
    // material rules: your face-up board cards whose VALUE matches (☆ matches anything);
    // SHAMIKO (MJG-HAT, non-negated) is any-VALUE from board/hand/discard; Rinshan
    // (Cute Boy) adds your hand + the discard TOP as sources (VALUE still must match).
    // Blocked while a meld restriction is active (Iishanten Hell) — a KAN is a meld.
    if (checkRestrictions(state, { kind: "meld", player: seat }) === null) {
      const rinshan = M.controlsRinshan(state, seat);
      me.meldZone.forEach((meld, meldIndex) => {
        if (meld.kind !== "triplet" || meld.kan) return;
        if (!meld.cards.every((c) => state.instances[c])) return; // opaque test melds — no instances to value
        const tv = M.tripletValue(state, meld);
        const matches = (iid: string) => {
          const inst = state.instances[iid];
          if (!inst || inst.protectedFromEffects || M.cannotBeMelded(state, iid)) return false;
          if (M.hasAbility(state, iid, "MJG-HAT") && !M.isEffectNegated(state, iid)) return true; // wild, from anywhere
          const mv = inst.value;
          return mv == null || tv == null || mv === tv;
        };
        const pool = new Set<string>();
        for (const iid of me.board) if (!state.instances[iid]?.faceDown && matches(iid)) pool.add(iid);
        for (const iid of me.hand) {
          const hat = M.hasAbility(state, iid, "MJG-HAT") && !M.isEffectNegated(state, iid);
          if ((rinshan || hat) && matches(iid)) pool.add(iid);
        }
        for (const iid of state.discard) {
          const hat = M.hasAbility(state, iid, "MJG-HAT") && !M.isEffectNegated(state, iid);
          if ((hat || (rinshan && state.discard[0] === iid)) && matches(iid)) pool.add(iid);
        }
        if (pool.size > 0) out.push({ kind: "kan", meldIndex, materialIds: [...pool] });
      });
    }
  }

  // response windows: only (At any time) abilities, from hand or board
  if (state.phase === M.Phase.ACTION_ANNOUNCED || state.phase === M.Phase.RESPONSE_WINDOW) {
    for (const iid of me.hand) out.push(...activations(state, seat, iid, "hand", ["anytime"]));
    for (const iid of me.board) out.push(...activations(state, seat, iid, "board", ["anytime"]));
  }
  return out;
}

/** Can `seat` legally respond in the current open window? (drives auto-pass) */
export function canRespond(state: GameState, seat: Seat): boolean {
  if (state.phase !== M.Phase.ACTION_ANNOUNCED && state.phase !== M.Phase.RESPONSE_WINDOW) return false;
  return legalActions(state, seat).some((a) => a.kind === "activate");
}
