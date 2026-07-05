/**
 * MJGTCG card effect scripts — Phase 1b first batch.
 *
 * Each entry maps `${cardId}:${role}` to an EffectScript implementing that
 * ability's RESOLUTION BODY. Activation conditions (text before the colon, e.g.
 * "If you have the least melds:", "(At any time)", "When you draw this card:")
 * and optionality ("You can ...") are ACTIVATION-LEGALITY concerns handled by a
 * later slice — a script runs only once the effect has been legally activated
 * and is resolving.
 *
 * This first batch covers cards whose body needs only the Phase 1a primitives
 * (specialSummon self / summonTopOfDeck / draw). Targeting, choices, stat
 * changes, banish, shuffle, melds-in-effect, etc. arrive with later slices.
 */
import type { EffectScript, StepList } from "./effects.js";
import { valueOf, atkOf, defOf, player, isEffectImmune, ariaTouches, type GameState } from "./reducer.js";
import { seatOrder, type Seat } from "./rules.js";

/** Special Summon this card (from hand), then optionally draw N. */
function ssSelf(draw = 0): EffectScript {
  return function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
    if (draw > 0) yield { kind: "draw", player: ctx.controller, count: draw };
  };
}
/** Special Summon the top card of the Main deck to the controller's board. */
const summonTop: EffectScript = function* (ctx) {
  yield { kind: "summonTopOfDeck", controller: ctx.controller };
};
/** Draw N from the given deck. */
function drawN(n: number, deck: "main" | "faith" = "main"): EffectScript {
  return function* (ctx) {
    yield { kind: "draw", player: ctx.controller, count: n, deck };
  };
}

export const CARD_SCRIPTS: Record<string, EffectScript> = {
  "MJG-001:bottom": summonTop, // What's Yaku? — SS top of deck
  // Cheese Chotto "Clean it Jannies": on summon, SS the chosen "TO Here" (AS4-PIN).
  // The candidate (and whether to use it) is picked when the trigger is placed; the
  // chosen copy arrives as ctx.targets[0]. See TRIGGER_TARGETS below.
  "MJG-003:top": function* (ctx) {
    const t = ctx.targets[0];
    if (t) {
      const fromDeck = ctx.state().mainDeck.includes(t);
      yield { kind: "specialSummon", iid: t, controller: ctx.controller };
      if (fromDeck) yield { kind: "shuffleDeck" }; // the deck was searched -> shuffle
    }
  },
  // Cheese Chotto "Koromo Janai zo!" (Active): draw the bottom card of the deck.
  "MJG-003:bottom": function* (ctx) {
    yield { kind: "draw", player: ctx.controller, count: 1, from: "bottom" };
  },
  // love "nya": discard this card, then Special Summon a "BIG ICHIHIME" (NYA-000) token.
  "NYA-001:top": function* (ctx) {
    yield { kind: "discard", iid: ctx.self };
    yield { kind: "summonToken", controller: ctx.controller, cardId: "NYA-000" };
  },
  // Look at this Hag! "I'm Looking!": reveal & return it to hand (stays in hand);
  // all players draw 1, anticlockwise from the activator.
  "MJG-002:top": function* (ctx) {
    yield { kind: "reveal", player: ctx.controller, iids: [ctx.self] }; // "Reveal this card"
    const s = ctx.state();
    const seating = s.seating.length ? [...s.seating] : s.players.map((p) => p.pid);
    for (const pid of seatOrder(seating, ctx.controller)) {
      if (!player(s, pid).eliminated) yield { kind: "draw", player: pid, count: 1 };
    }
  },
  // Adeptchads "A White Hole?": each player (anticlockwise) adds the current top
  // of the shared discard pile to their hand.
  "MJG-008:top": function* (ctx) {
    const seating = ctx.state().seating.length ? [...ctx.state().seating] : ctx.state().players.map((p) => p.pid);
    for (const pid of seatOrder(seating, ctx.controller)) {
      if (player(ctx.state(), pid).eliminated) continue;
      if (ctx.state().discard.length === 0) break;
      yield { kind: "takeDiscardTop", player: pid };
    }
  },
  // Adeptchads "A Black Hole?": each player discards all face-up cards on their
  // board (including this card). Per FAQ §9 the discards are one-at-a-time and
  // respondable — the turn player first, then anticlockwise, each owner choosing
  // their own order — so this just queues the groups for the FORCED_DISCARD flow.
  "MJG-008:bottom": function* (ctx) {
    const s = ctx.state();
    const seating = s.seating.length ? [...s.seating] : s.players.map((p) => p.pid);
    const groups = seatOrder(seating, s.activePlayer)
      .map((pid) => {
        const p = s.players.find((x) => x.pid === pid);
        const iids = p && !p.eliminated ? p.board.filter((b) => !s.instances[b]?.faceDown) : [];
        return { player: pid, iids };
      })
      .filter((g) => g.iids.length > 0);
    if (groups.length) yield { kind: "forcedDiscard", groups };
  },
  // Koko Doko "Koko!" is step-wise (window before the draw) — see CARD_STEPS.
  // Koko Doko "So Unlucky": reveal the top 3; special-meld them if they form a
  // valid meld, otherwise shuffle them back into the deck.
  "FAT-009:bottom": function* (ctx) {
    yield { kind: "reveal", player: ctx.controller, iids: ctx.state().mainDeck.slice(0, 3) }; // "Reveal the top 3 cards"
    yield { kind: "meldFromDeckTop", player: ctx.controller, count: 3 };
  },
  // Literally Who? "Watson" is step-wise (banish; then draw) and its random pick +
  // VALUE guess are an activation condition — see CARD_STEPS and ACTIVATION_CHOICES.
  // Good Morning Sirs! "iTunes Gift Card": the targeted opponent decided (ctx.opt).
  // Redeem -> this card to their hand + you draw 2; decline -> Special Summon it.
  "MJG-015:top": function* (ctx) {
    if (ctx.opt) {
      yield { kind: "moveToHand", iid: ctx.self, player: Number(ctx.targets[0]) as typeof ctx.controller };
      yield { kind: "draw", player: ctx.controller, count: 2 };
    } else {
      yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
    }
  },
  // Good Morning Sirs! "Belly Dance" (MJG-015:bottom) is resolved by the session: it
  // gathers the chosen character's Active (role + its targets) and TRANSFORMS this
  // chain link into that Active, so there's no wrapper script here.
  "MJG-013:top": ssSelf(), // Banana "Ehe…" — SS this (on draw)
  "MJG-013:bottom": drawN(2), // Banana "RAKII" — draw 2 when melded
  "MJG-031:top": ssSelf(), // Chuuni-Sister-Daughter-Wife — SS this
  // Imouto "Onii-chan?": SS the chosen stronger hand card (picked at resolution
  // via RESOLVE_CHOICES choose:"hand" + strongerThan filter).
  "MJG-031:bottom": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "specialSummon", iid: ctx.targets[0], controller: ctx.controller };
  },
  "MJG-041:top": ssSelf(), // p*n*s — SS this
  "MJG-C07:top": ssSelf(), // ywnbaw7 — SS this
  "MJG-C08:top": ssSelf(), // What are the odds... — SS this
  "MJG-M16:top": ssSelf(), // SMMR — SS this
  // Mixing Magic "c" (Active): every player, anticlockwise from the activator, draws
  // up to 4 cards in hand (a player already at 4+ draws nothing).
  "MJG-M16:bottom": function* (ctx) {
    const s = ctx.state();
    const seating = s.seating.length ? [...s.seating] : s.players.map((p) => p.pid);
    for (const pid of seatOrder(seating, ctx.controller)) {
      const p = player(ctx.state(), pid);
      if (p.eliminated) continue;
      const need = 4 - p.hand.length;
      if (need > 0) yield { kind: "draw", player: pid, count: need };
    }
  },
  "MJG-M15:bottom": ssSelf(), // Sechs with Zechs — SS this
  "MJG-M22:top": ssSelf(), // Tea Leaves — SS this
  "MJG-012:top": ssSelf(), // Literally Who? — SS this
  "BAK-YOU:top": ssSelf(), // Friendly Only Bnuuy "Watapon" — SS this (on effect-to-hand)
  // Bnuuy "Book of Moon" (optional, on summon): flip the chosen other character
  // face-down until the start of the controller's next turn.
  "BAK-YOU:bottom": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "flipDown", iid: ctx.targets[0], player: ctx.controller };
  },
  "MJG-888:bottom": drawN(1, "faith"), // Gweilo! "Buy Jade" — draw 1 from Faith
  // Gweilo! "Frustrated?": the cost (discard this + 2) happened at activation;
  // targets = [opponent seat, picked card from their hand] — add the pick to
  // the controller's hand (one `and`-joined sentence, no inner windows).
  "MJG-888:top": function* (ctx) {
    const picked = ctx.targets[1];
    if (picked) yield { kind: "moveToHand", iid: picked, player: ctx.controller };
  },
  "MJG-C14:bottom": drawN(12), // Waschizo "WASHI NO IIPIN" — draw 12

  // --- targeting slice (target chosen & locked at activation -> ctx.targets) ---
  // TO Here "B&" / "Thread Moved" are step-wise (window before the final move) — see CARD_STEPS.
  // Miko "MIKO MIKO MII" (Spell, At any time): when YOUR card would be discarded
  // by battle, Special Summon this card from hand INSTEAD — your card is saved.
  "UGR-005:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
    yield { kind: "preventBattleDiscard", player: ctx.controller };
  },
  // Yuzu "+1 Image" (At any time): Special Summon this card from hand to ANY
  // board — the chosen player (target = seat) becomes its controller.
  "MJG-029:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: Number(ctx.targets[0]) as typeof ctx.controller };
  },
  // YUZU GRAPE "Correction" is step-wise (SS this; then banish the target) — see CARD_STEPS.
  // YUZU GRAPE "Fortune Telling": reorder the top of the deck — ctx.targets is the
  // chosen order (gathered at resolution: top-4 cards, controller-private).
  "MJG-77*:bottom": function* (ctx) {
    if (ctx.targets.length) yield { kind: "reorderTop", order: [...ctx.targets] };
  },
  // Hotwheels "Break a Leg": SS this card by overlaying it on the targeted
  // opponent's character — it lands on THAT player's board (they control it),
  // with the character tucked beneath as an overlay.
  "KSG-EMI:top": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0] };
  },
  // Hotwheels "Trolley Problem" (mandatory, end of the controller's turn): move
  // this and the chosen other controlled character (if any) to the shimocha's
  // (next seat anticlockwise) board. The trolley rolls on.
  "KSG-EMI:bottom": function* (ctx) {
    const s = ctx.state();
    const seating = s.seating.length ? [...s.seating] : s.players.map((p) => p.pid);
    const living = s.players.filter((p) => !p.eliminated).map((p) => p.pid);
    const shimocha = seatOrder(seating, ctx.controller).find((pid) => pid !== ctx.controller && living.includes(pid));
    if (shimocha === undefined) return; // no one to roll to
    yield { kind: "moveToBoard", iid: ctx.self, player: shimocha };
    if (ctx.targets[0]) yield { kind: "moveToBoard", iid: ctx.targets[0], player: shimocha };
  },
  // Liyuean Opera "Ear Rape" (mandatory, on summon): stun every OTHER character on
  // every board until the next time its own owner ends their turn.
  "MJG-045:top": function* (ctx) {
    const s = ctx.state();
    for (const p of s.players) {
      if (p.eliminated) continue;
      for (const iid of p.board) {
        if (iid === ctx.self) continue;
        yield { kind: "stun", iid, untilEndOfTurnOf: p.pid };
      }
    }
  },
  // Liyuean Opera "Lead Character": the chosen hand card goes ON TOP of this character
  // (covers it — this card tucks beneath), but arrives STUNNED. At the end of your turn
  // the cover returns to your hand and this character pops back onto the board.
  "MJG-045:bottom": function* (ctx) {
    if (!ctx.targets[0]) return;
    yield { kind: "coverWith", host: ctx.self, card: ctx.targets[0], returnAtEndOfTurnOf: ctx.controller };
    yield { kind: "stun", iid: ctx.targets[0], untilEndOfTurnOf: ctx.controller };
  },
  // My /mjg/ Crush "Matchmaker": bond the 2 targeted characters until the start
  // of your next turn (can't attack each other; shared discard fate). The top
  // (Cupid Doesn't Exist) is a passive enforced in legalActions/declareBattle.
  "MJG-M11:bottom": function* (ctx) {
    if (ctx.targets[0] && ctx.targets[1]) yield { kind: "matchmakerBond", a: ctx.targets[0], b: ctx.targets[1], player: ctx.controller };
  },
  // El Negro Kang "Immigration": SS the chosen [Furry] from the discard pile
  // (picked at resolution via RESOLVE_CHOICES choose:"discard" + furry filter).
  "MJG-M18:bottom": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "specialSummon", iid: ctx.targets[0], controller: ctx.controller };
  },
  // It's Actually Over "Tie the Noose" (At any time): discard this card. That's it.
  // Pure chain fodder ("can interrupt but not negate melds").
  "MJG-M09:top": function* (ctx) {
    yield { kind: "discard", iid: ctx.self };
  },
  // It's Actually Over "Going to Gensokyo" (mandatory): if SPECIAL Summoned,
  // discard it — it can't be cheated onto the board.
  "MJG-M09:bottom": function* (ctx) {
    yield { kind: "discard", iid: ctx.self };
  },
  // i'm in your walls "Second Amendment" (mandatory, opponentSummon): this card
  // immediately attacks the just-summoned character (a normal, two-sided battle —
  // both can be discarded). The summoned card arrives as ctx.targets[0].
  "MJG-M12:bottom": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "effectAttack", attacker: ctx.self, target: ctx.targets[0] };
  },
  // Famous Fagat "Trap Trick" (At any time): flip the targeted character face-down
  // until the END of this turn, AND (simultaneous) SS this card. The flip schedule
  // is keyed to the CURRENT turn's player (it lapses when this turn ends).
  "MJG-M13:top": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "flipDown", iid: ctx.targets[0], player: ctx.state().activePlayer, until: "endOfThisTurn" };
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // The Jongker "BAAAANG" (At any time): discard YOUR whole hand (this card included),
  // and then the targeted (10+ card) opponent discards their whole hand.
  "MJG-M21:top": function* (ctx) {
    const s = ctx.state();
    const oppId = Number(ctx.targets[0]) as Seat;
    // both hands snapshot now; each player chooses THEIR OWN discard order, one
    // card per response window — yours first, then theirs
    yield { kind: "discardOneByOne", iids: [...player(s, ctx.controller).hand], chooser: ctx.controller };
    yield { kind: "discardOneByOne", iids: [...player(s, oppId).hand], chooser: oppId };
  },
  // Copebots "Call Slut" (optional, opponentDiscard): make a Special Meld using the
  // opponent's just-discarded card (targets[0]), this card, and a chosen completer from
  // your board/hand (targets[1], gathered at resolution).
  "MJG-C06:top": function* (ctx) {
    const [discarded, completer] = ctx.targets;
    if (discarded && completer) yield { kind: "meldBoard", player: ctx.controller, materials: [discarded, ctx.self, completer] };
  },
  // What are the odds... "Deus ex Machina" (Active): you win the game.
  "MJG-C08:bottom": function* (ctx) {
    yield { kind: "winGame", player: ctx.controller };
  },
  // Ohohojousama "Honester Gamble": both revealed a random hand card (targets[1]=
  // opponent's, targets[2]=yours); whoever revealed the HIGHER VALUE draws 2 (a ☆ has
  // no VALUE -> never highest; ties do nothing).
  "MJG-C10:bottom": function* (ctx) {
    const oppCard = ctx.targets[1], myCard = ctx.targets[2];
    if (!oppCard || !myCard) return;
    const s = ctx.state();
    const mine = valueOf(s, myCard) ?? -Infinity;
    const theirs = valueOf(s, oppCard) ?? -Infinity;
    if (mine > theirs) yield { kind: "draw", player: ctx.controller, count: 2 };
    else if (theirs > mine) yield { kind: "draw", player: Number(ctx.targets[0]) as Seat, count: 2 };
  },
  // YUME "Honest Gamble": both revealed a random hand card (targets[1]=opponent's,
  // targets[2]=yours); whoever revealed the lower VALUE discards it (a ☆ has no VALUE
  // -> never the lowest; ties do nothing).
  "MJG-C09:bottom": function* (ctx) {
    const oppCard = ctx.targets[1], myCard = ctx.targets[2];
    if (!oppCard || !myCard) return; // a hand was empty -> no contest
    const s = ctx.state();
    const mine = valueOf(s, myCard) ?? Infinity;
    const theirs = valueOf(s, oppCard) ?? Infinity;
    if (mine < theirs) yield { kind: "discard", iid: myCard };
    else if (theirs < mine) yield { kind: "discard", iid: oppCard };
  },
  // KIRA "Honestest Gamble": same lowest-VALUE-discards contest as Honest Gamble, but
  // each player CHOOSES which hand card to reveal (resolution is identical; the choosing
  // happens at activation). targets[1]=opponent's, targets[2]=yours.
  "MJG-C11:bottom": function* (ctx) {
    const oppCard = ctx.targets[1], myCard = ctx.targets[2];
    if (!oppCard || !myCard) return; // a hand was empty -> no contest
    const s = ctx.state();
    const mine = valueOf(s, myCard) ?? Infinity;
    const theirs = valueOf(s, oppCard) ?? Infinity;
    if (mine < theirs) yield { kind: "discard", iid: myCard };
    else if (theirs < mine) yield { kind: "discard", iid: oppCard };
  },
  // MIDA "Beautification Council": all players discard half their hand. The discards are
  // each player's own choice, gathered anticlockwise at resolution (see RESOLVE_CHOICES
  // halfDiscard) — nothing to yield here.
  "MJG-C12:top": function* () {},
  // MIDA "Double or Nothing": both revealed a random hand card (targets[1]=opponent's,
  // targets[2]=yours). If YOU revealed the strictly lower VALUE, discard your whole hand;
  // otherwise (higher OR tie) draw cards equal to your hand size. A ☆ has no VALUE -> it
  // is treated as the highest (so it is never "lower").
  "MJG-C12:bottom": function* (ctx) {
    const oppCard = ctx.targets[1], myCard = ctx.targets[2];
    if (!oppCard || !myCard) return; // a hand was empty -> no contest
    const s = ctx.state();
    const mine = valueOf(s, myCard) ?? Infinity;
    const theirs = valueOf(s, oppCard) ?? Infinity;
    if (mine < theirs) {
      yield { kind: "discardOneByOne", iids: [...player(s, ctx.controller).hand], chooser: ctx.controller }; // lower -> discard everything, own order
    } else {
      const n = player(s, ctx.controller).hand.length; // higher / tie -> double up
      if (n > 0) yield { kind: "draw", player: ctx.controller, count: n };
    }
  },
  // ywnbaw7 "Diabolus ex Machina" (Active): draw the ENTIRE deck, then schedule your hand
  // to shuffle back into the deck at the end of this turn.
  "MJG-C07:bottom": function* (ctx) {
    const n = ctx.state().mainDeck.length;
    if (n > 0) yield { kind: "draw", player: ctx.controller, count: n };
    yield { kind: "scheduleHandShuffle", player: ctx.controller };
  },
  // Copebots "Log Review" (Active): the revealed top card (targets[0]) — if it could meld
  // with 2 of your board cards (ctx.opt set at activation), give it to the next opponent;
  // otherwise draw it.
  "MJG-C06:bottom": function* (ctx) {
    const T = ctx.targets[0];
    if (!T) return;
    if (ctx.opt) {
      const s = ctx.state();
      const seating = s.seating.length ? [...s.seating] : s.players.map((p) => p.pid);
      const opp = seatOrder(seating, ctx.controller).find((pid) => pid !== ctx.controller && !player(s, pid).eliminated);
      if (opp !== undefined) yield { kind: "moveToHand", iid: T, player: opp };
    } else {
      yield { kind: "draw", player: ctx.controller, count: 1 }; // draw the revealed top card
    }
  },
  // All My Mahjong Friends Have Died "Shoumakyou" (At any time, after an opponent
  // resolves an effect): discard this card, then lock opponents out of activating
  // effects for the rest of this turn.
  "MJG-C04:top": function* (ctx) {
    yield { kind: "discard", iid: ctx.self };
    yield { kind: "setEffectLock", player: ctx.controller };
  },
  // All My Mahjong Friends Have Died "Winning Streak" (mandatory, controllerMeld):
  // after you make a meld (not using this card), draw 1 per meld you have.
  "MJG-C04:bottom": function* (ctx) {
    const n = player(ctx.state(), ctx.controller).meldZone.length;
    if (n > 0) yield { kind: "draw", player: ctx.controller, count: n };
  },
  // amaekoromo "Haitei Raoyue": if the controller chose to meld (targets = the drawn
  // card + 2 picked board/discard cards), make that Special Meld. The drawn card is
  // pulled from hand; the others from board/discard (meldBoardCards is zone-agnostic).
  "MJG-C03:bottom": function* (ctx) {
    if (ctx.targets.length === 3) yield { kind: "meldBoard", player: ctx.controller, materials: [...ctx.targets] };
  },
  // Elegant "Drop Trading" (mandatory, opponentTurn): add the top of the discard pile
  // to your hand at the end of each opponent's turn (no-op if the pile is empty).
  "MJG-M23:top": function* (ctx) {
    if (ctx.state().discard.length > 0) yield { kind: "takeDiscardTop", player: ctx.controller };
  },
  // Elegant "Buying gf": give 2 of your hand cards (gathered at resolution) to the
  // targeted FEMALE's owner, and take control of that character.
  "MJG-M23:bottom": function* (ctx) {
    const target = ctx.targets[0];
    if (!target) return;
    const owner = ctx.state().players.find((p) => p.board.includes(target))?.pid;
    if (owner === undefined) return; // the character left play -> fizzle
    for (const c of ctx.targets.slice(1, 3)) if (c) yield { kind: "moveToHand", iid: c, player: owner };
    yield { kind: "moveToBoard", iid: target, player: ctx.controller };
  },
  // Majsoul Secret Room "Secret Rumors": the 2 face-down cards were placed on your
  // board as the cost (targets[1..2]); the opponent blindly picked one (targets[3]).
  // Move the picked card to their board, then schedule BOTH to flip up at the start of
  // their (final) controller's next turn.
  "MJG-M22:bottom": function* (ctx) {
    const t = ctx.targets;
    const opp = Number(t[0]) as Seat;
    const chosen = t[3];
    if (chosen) yield { kind: "moveToBoard", iid: chosen, player: opp };
    for (const c of [t[1], t[2]]) {
      if (!c) continue;
      const ctrl = ctx.state().players.find((pl) => pl.board.includes(c))?.pid;
      if (ctrl !== undefined) yield { kind: "flipDown", iid: c, player: ctrl }; // schedule flip-up (card is already face-down)
    }
  },
  // The Jongker "Joker's Joke" (Active): each player, anticlockwise from the activator,
  // draws 3, discards 2 random from hand, and gains 1 Clown counter.
  "MJG-M21:bottom": function* (ctx) {
    const s0 = ctx.state();
    const seating = s0.seating.length ? [...s0.seating] : s0.players.map((p) => p.pid);
    for (const pid of seatOrder(seating, ctx.controller)) {
      if (player(ctx.state(), pid).eliminated) continue;
      yield { kind: "draw", player: pid, count: 3 };
      yield { kind: "discardRandom", player: pid, count: 2 };
      yield { kind: "playerCounter", player: pid, counter: "Clown", amount: 1 };
    }
  },
  // Flow Book 1 "Tile Efficiency": SS this card; AND force the targeted opponent to
  // make a Special Meld from their 3 targeted characters (into THEIR meld zone, no
  // Faith draw). "They do not draw" is the noFaith flag (informational trailing clause).
  "MJG-M19:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
    const s = ctx.state();
    const owner = s.players.find((p) => ctx.targets.length === 3 && ctx.targets.every((t) => p.board.includes(t)));
    if (owner) yield { kind: "meldBoard", player: owner.pid, materials: [...ctx.targets], noFaith: true };
  },
  // Flow Book 1 "We Gottem": reveal the targeted opponent's hand, then add all their
  // [Cunny] and [Shota] cards to your hand.
  // Mooncakes "Soulless" (Active, once per game): every player who never activated
  // Emote Spam skips their next turn (the activator included, if they never cast it).
  "MOON-001:bottom": function* (ctx) {
    const s = ctx.state();
    for (const p of s.players) {
      if (p.eliminated) continue;
      if ((p.counters["Mooncake"] ?? 0) === 0) yield { kind: "skipTurn", player: p.pid };
    }
  },
  // Mutsugaki "Explosive Aria": targets[0] = the hand card picked at resolution,
  // targets[1] = "seat:x:y:page" (the owner's click on a board). Everything the
  // placed card's rect touches on that page is discarded — and then itself.
  "MSGK-C30:bottom": function* (ctx) {
    const card = ctx.targets[0];
    const place = ctx.targets[1];
    if (!card || !place) return; // never picked/placed (e.g. hand emptied) -> fizzle
    const [seat, x, y, page] = place.split(":").map(Number) as [Seat, number, number, number];
    const s = ctx.state();
    if (!s.players.some((p) => p.hand.includes(card))) return; // left the hand -> fizzle
    if (!s.players.some((p) => p.pid === seat && !p.eliminated)) return;
    const touched = ariaTouches(s, seat, x, y, page);
    yield { kind: "reveal", player: ctx.controller, iids: [card] }; // the placed card is public
    yield { kind: "discardOneByOne", iids: touched, chooser: seat }; // the board's owner orders the blast
    yield { kind: "discardOneByOne", iids: [card] }; // ...and then itself
  },
  "MJG-M19:bottom": function* (ctx) {
    // the reveal popup happened at the session's confirm stage (revealTargetHand)
    const oppId = Number(ctx.targets[0]) as Seat;
    const s = ctx.state();
    const opp = s.players.find((p) => p.pid === oppId);
    if (!opp) return; // the reveal itself (to everyone, logged) happened at the popup stage
    const grab = opp.hand.filter((iid) => {
      const tr = s.instances[iid]?.tribes ?? [];
      return tr.includes("Cunny") || tr.includes("Shota");
    });
    for (const iid of grab) yield { kind: "moveToHand", iid, player: ctx.controller };
    for (const p of s.players) // private again (the reveal was to every player)
      if (p.pid !== oppId) yield { kind: "endHandReveal", owner: oppId, viewer: p.pid };
  },
  // Divegrass is Ruined! "CAM ON MJG": SS the chosen hand card (gathered at
  // resolution — handAtStep, excluding this card; summonable) to the targeted
  // opponent's board, and then SS this card to your own board.
  "MJG-M14:top": function* (ctx) {
    const opp = Number(ctx.targets[0]) as Seat;
    const handCard = ctx.targets[1]; // the picked hand card (appended at resolution)
    if (handCard) yield { kind: "specialSummon", iid: handCard, controller: opp };
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // Divegrass is Ruined! "SCOR SOM FACKIN MANGANS": meld the targeted opponent's
  // VALUE-1 and VALUE-3 characters together with this card (VALUE 2) into a 1-2-3
  // Normal Meld in YOUR meld zone (the materials leave their board).
  "MJG-M14:bottom": function* (ctx) {
    const s = ctx.state();
    const opp = s.players.find((p) => p.pid === Number(ctx.targets[0]));
    if (!opp) return;
    const ok = (iid: string) => !s.instances[iid]?.faceDown && s.instances[iid]?.cardId !== null
      && !s.instances[iid]?.protectedFromEffects && !isEffectImmune(s, iid);
    const v1 = opp.board.find((b) => ok(b) && valueOf(s, b) === 1);
    const v3 = opp.board.find((b) => ok(b) && valueOf(s, b) === 3);
    if (v1 && v3) yield { kind: "meldBoard", player: ctx.controller, materials: [v1, ctx.self, v3] };
  },
  // Famous Fagat "Gay ERP" (Active): swap places (control) with the targeted opponent
  // character — this card goes to their board, theirs comes to yours — then flip this
  // card face-down until the START of that opponent's next turn.
  "MJG-M13:bottom": function* (ctx) {
    const target = ctx.targets[0];
    if (!target) return;
    const s = ctx.state();
    const opp = s.players.find((p) => p.board.includes(target))?.pid;
    if (opp === undefined || !s.players.some((p) => p.board.includes(ctx.self))) return; // a participant left play -> fizzle
    yield { kind: "moveToBoard", iid: ctx.self, player: opp }; // this card -> opponent's board
    yield { kind: "moveToBoard", iid: target, player: ctx.controller }; // their character -> your board
    yield { kind: "flipDown", iid: ctx.self, player: opp }; // face-down until the start of that opponent's next turn
  },
  // El Primer Furry "Slippery Slope": add the searched [Furry] to your hand — a
  // searched deck is always shuffled, even when the search found nothing.
  "MJG-M07:bottom": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "moveToHand", iid: ctx.targets[0], player: ctx.controller };
    yield { kind: "shuffleDeck" };
  },
  // RUSSIAN "Collusion": the cost (discard this + show your hand to the target)
  // happened at activation; if the target agreed to show theirs back (ctx.opt),
  // the reverse reveal happens and both of you draw 3 (controller first).
  "MJG-M04:top": function* (ctx) {
    const target = Number(ctx.targets[0]) as Seat;
    if (!ctx.opt) {
      // rejected: the shown hand goes straight back to private info
      yield { kind: "endHandReveal", owner: ctx.controller, viewer: target };
      return;
    }
    // the reveal-back happened at the session's ACK stage (the activator confirmed
    // on the shown-hand popup, PRE-draw) — here the draws resolve and BOTH hands
    // return to private info (the deal is done)
    yield { kind: "draw", player: ctx.controller, count: 3 };
    yield { kind: "draw", player: target, count: 3 };
    yield { kind: "endHandReveal", owner: ctx.controller, viewer: target };
    yield { kind: "endHandReveal", owner: target, viewer: ctx.controller };
  },
  // RUSSIAN "Target Ron": both sides' meld picks were appended at resolution
  // (targets = [seat, ctrlMeldIdx, targetMeldIdx]; "-1" = that side has none).
  "MJG-M04:bottom": function* (ctx) {
    const target = Number(ctx.targets[0]) as Seat;
    const mine = Number(ctx.targets[1]);
    const theirs = Number(ctx.targets[2]);
    if (mine >= 0) yield { kind: "discardMeld", player: ctx.controller, index: mine };
    if (theirs >= 0) yield { kind: "discardMeld", player: target, index: theirs };
  },
  // I'm at the bar... "The Usual?": the top-3 reveal happened at activation
  // (targets = [opponent seat, ...revealed], reordered to put THEIR pick at [1]).
  // They get the pick; you add the remaining revealed cards to your hand.
  "MJG-M02:bottom": function* (ctx) {
    const target = Number(ctx.targets[0]) as Seat;
    if (ctx.targets[1]) yield { kind: "moveToHand", iid: ctx.targets[1], player: target };
    for (const rest of ctx.targets.slice(2)) yield { kind: "moveToHand", iid: rest, player: ctx.controller };
  },
  // Jane4 "Useless Censors": the reveal+target happened at activation (the chain
  // makes the card public; it stays in hand); flip the face-down target face-up.
  "MJG-047:top": function* (ctx) {
    yield { kind: "reveal", player: ctx.controller, iids: [ctx.self] }; // "Reveal this card"
    if (ctx.targets[0]) yield { kind: "flipUp", iid: ctx.targets[0] };
  },
  // Jane4 "Doxxed" (bottom) is a pure view rule: while in play, the top of both
  // decks is shown — implemented in the session's redactFor, no script.
  // UNTZ "Party Hard" (mandatory, on summon): every character — including this
  // card and the movers' own boards as destinations — moves to a random board.
  "MJG-046:top": function* () {
    yield { kind: "scrambleBoards" };
  },
  // UNTZ "Deuteragonist": overlay the chosen hand card on this character (it rides
  // along — no return), and then scramble all boards.
  // UNTZ "Deuteragonist": the chosen hand card goes ON TOP of this character (covers
  // it — UNTZ tucks beneath as a material), then everyone scatters. No return clause.
  "MJG-046:bottom": function* (ctx) {
    if (!ctx.targets[0]) return;
    yield { kind: "coverWith", host: ctx.self, card: ctx.targets[0] };
    yield { kind: "scrambleBoards" };
  },
  // YJK "Mojito": SS the chosen 3-ATK hand card (picked at resolution via
  // RESOLVE_CHOICES choose:"hand"). Animal Tamer (top) is a meld rule in doMeld.
  "MJG-043:bottom": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "specialSummon", iid: ctx.targets[0], controller: ctx.controller };
  },
  // Ravioli Ravioli "succ": the attach-and-repeat loop is session-driven
  // (RESOLVE_CHOICES succ — attaches happen during the prompts); no-op body.
  "MJG-039:top": function* () {},
  // BIG FLAT CAT TATS "*glomp*": draw 1 for each face-up [Furry] on any living
  // player's board — itself included (negated Furries still count; only their
  // own effects are off).
  "MJG-0w0:bottom": function* (ctx) {
    const s = ctx.state();
    const n = s.players
      .flatMap((p) => (p.eliminated ? [] : p.board))
      .filter((iid) => !s.instances[iid]?.faceDown && s.instances[iid]?.tribes.includes("Furry")).length;
    if (n > 0) yield { kind: "draw", player: ctx.controller, count: n };
  },
  // Take your meds "Immunize": the target cannot be melded or removed from the
  // owner's board by effects until the start of the CONTROLLER's next turn.
  "MJG-035:bottom": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "grantImmunity", iid: ctx.targets[0], player: ctx.controller };
  },
  // Ninjutsu "Shadow Clone": SS the chosen hand card with its EFFECTS NEGATED and
  // its fate linked to this card — when this leaves the controller's board, all
  // its clones are discarded (the checkShadowClones invariant).
  "MJG-333:bottom": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "specialSummon", iid: ctx.targets[0], controller: ctx.controller, negated: true, linkedBy: ctx.self };
  },
  // NEET "Simp": the target's picks (deck top 3, >=1) were appended to targets by
  // the session (RESOLVE_CHOICES simp); move them to the CONTROLLER's hand — the
  // unpicked cards never left the deck, staying in the same order.
  "JONG-030:bottom": function* (ctx) {
    for (const t of ctx.targets.slice(1)) yield { kind: "moveToHand", iid: t, player: ctx.controller };
  },
  // Bravo "Big if True": the reveal-until happened at activation (pre-colon —
  // ACTIVATION_CHOICES excavate); targets = the revealed VALUE-4+ cards. Add them
  // to the hand and shuffle the deck ("shuffle the rest back").
  "MJG-026:bottom": function* (ctx) {
    for (const t of ctx.targets) yield { kind: "moveToHand", iid: t, player: ctx.controller };
    yield { kind: "shuffleDeck" };
  },
  // G***u "Copestream" (mandatory): if you discard this card (from anywhere), skip
  // your next turn.
  "MJG-020:top": function* (ctx) {
    yield { kind: "skipTurn", player: ctx.controller };
  },
  // G***u "Fatherless Behaviour": an interactive odd/even guessing game — entirely
  // session-driven (RESOLVE_CHOICES parity flow); the discards happen during the
  // prompts, so the script body is a no-op.
  "MJG-020:bottom": function* () {},
  // Rigged Hands "Typical Haipai" (optional, on summon): shuffle your hand into the
  // deck and draw the same number — `and`-joined, so one simultaneous step.
  "MJG-018:top": function* (ctx) {
    const n = player(ctx.state(), ctx.controller).hand.length;
    if (n === 0) return; // nothing to shuffle -> nothing to draw (R16)
    yield { kind: "shuffleHandIntoDeck", player: ctx.controller };
    yield { kind: "draw", player: ctx.controller, count: n };
  },
  // Rigged Hands "Mr Rabbit": return the target to the owner's hand.
  "MJG-018:bottom": function* (ctx) {
    yield { kind: "moveTo", iid: ctx.targets[0]!, to: "hand" };
  },
  // MADO "Cold Attitude": banish the target, then Special Summon this card.
  "MJG-C33:top": function* (ctx) {
    yield { kind: "moveTo", iid: ctx.targets[0]!, to: "banish" };
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // Shamiko Punch: discard the target (a character with 0 DEF).
  "SHA-001:top": function* (ctx) {
    yield { kind: "reveal", player: ctx.controller, iids: [ctx.self] }; // "Reveal this card"
    yield { kind: "discard", iid: ctx.targets[0]! };
  },
  // JOSP "RAWN" is step-wise (discard this card; then place the target on the discard bottom) — see CARD_STEPS.
  // JOSP "TSUOM" (mandatory, when melded from anywhere): each opponent's discard
  // pick is session-driven (RESOLVE_CHOICES tsuom); no-op body.
  "MJG-M06:bottom": function* () {},

  // --- stat-modification slice ---
  // Mommy Milkers "From the Source": Double the target's ATK and DEF until EOT.
  "MJG-32歳:bottom": function* (ctx) {
    const t = ctx.targets[0]!;
    const s = ctx.state();
    // "Double its ATK and DEF": double whatever they CURRENTLY are (after every existing
    // mod/aura), by snapshotting the current effective values and adding them — so a `mul`
    // on the base doesn't ignore later modifiers, and further changes stack on top.
    yield { kind: "statMod", iid: t, stat: "atk", op: "add", amount: atkOf(s, t), duration: "endOfTurn" };
    yield { kind: "statMod", iid: t, stat: "def", op: "add", amount: defOf(s, t), duration: "endOfTurn" };
  },

  // --- triggered effects slice ---
  // HNTA "Sprout": At the end of each player's turn, you can draw 1 card.
  "MJG-014:bottom": drawN(1),

  // Dnruk "Tipsy" (Mandatory): at the end of YOUR turn, draw 2 then discard 1
  // random card from your hand.
  "MJG-006:top": function* (ctx) {
    yield { kind: "draw", player: ctx.controller, count: 2 };
    yield { kind: "discardRandom", player: ctx.controller, count: 1 };
  },
  // Dnruk "SEX" (Active): pool your hand with the targeted opponent's, shuffle,
  // and re-deal each their original number of cards. (target = opponent seat.)
  "MJG-006:bottom": function* (ctx) {
    yield { kind: "redistributeHands", players: [ctx.controller, Number(ctx.targets[0]) as typeof ctx.controller] };
  },

  // KEIS "Treasurer": top 2 of the deck were revealed at activation (targets[0..1]);
  // sum their VALUEs. 6 or 8 -> add both to your hand; 7 -> hand>7 players discard half
  // (run as a resolve-choice before this); anything else -> nothing. In every non-6/8
  // case the revealed cards are shuffled back. (A ☆ has no VALUE -> the sum can't match.)
  "MJG-C17:bottom": function* (ctx) {
    const c0 = ctx.targets[0], c1 = ctx.targets[1];
    if (!c0 || !c1) return; // fewer than 2 cards in the deck -> no contest
    const s = ctx.state();
    const v0 = valueOf(s, c0), v1 = valueOf(s, c1);
    const sum = v0 === null || v1 === null ? -1 : v0 + v1;
    if (sum === 6 || sum === 8) {
      yield { kind: "moveToHand", iid: c0, player: ctx.controller };
      yield { kind: "moveToHand", iid: c1, player: ctx.controller };
    } else {
      yield { kind: "shuffleDeck" }; // (shuffle the revealed cards back); the sum-7 discard already ran
    }
  },
  // KAGY "Ice Princess": When summoned, discard all characters with VALUE <= 4.
  // (KAGY itself is VALUE 5, so it survives.)
  "MJG-C15:top": function* (ctx) {
    const s = ctx.state();
    const victims: string[] = [];
    for (const p of s.players) {
      for (const iid of p.board) {
        const v = valueOf(s, iid);
        if (v !== null && v <= 4) victims.push(iid);
      }
    }
    // a wipe is sequential and each owner orders their own losses (seat order from the controller)
    for (const pid of seatOrder(s.players.map((p) => p.pid), ctx.controller)) {
      const own = victims.filter((v) => player(s, pid).board.includes(v));
      if (own.length) yield { kind: "discardOneByOne", iids: own, chooser: pid };
    }
  },

  // Swordslut "Banzai!": after it discards a character by battle, +2 ATK / -2 DEF
  // (min 0) and it can attack again this turn.
  "MJG-027:bottom": function* (ctx) {
    yield { kind: "statMod", iid: ctx.self, stat: "atk", op: "add", amount: 2, duration: "persistent" };
    yield { kind: "statMod", iid: ctx.self, stat: "def", op: "add", amount: -2, duration: "persistent" };
    yield { kind: "untap", iid: ctx.self };
  },
  // AI(Steve) "Terminator": after it discards a character by battle, -2 ATK (min 0)
  // / +2 DEF and it can attack again this turn.
  "MJG-037:bottom": function* (ctx) {
    yield { kind: "statMod", iid: ctx.self, stat: "atk", op: "add", amount: -2, duration: "persistent" };
    yield { kind: "statMod", iid: ctx.self, stat: "def", op: "add", amount: 2, duration: "persistent" };
    yield { kind: "untap", iid: ctx.self };
  },
  // Hanana "LTG": the targeted opponent chose a board card to discard (targets[1], "-1"
  // if their board was empty), AND you Special Summon this card — one `and`-joined step.
  "MJG-C32:top": function* (ctx) {
    const chosen = ctx.targets[1];
    if (chosen && chosen !== "-1") yield { kind: "discard", iid: chosen };
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // Friendly Uncle "Candy": gain control of the targeted [Cunny]/[Shota] (move it to your
  // board) AND Special Summon this card — one `and`-joined step.
  "MJG-M08:top": function* (ctx) {
    yield { kind: "moveToBoard", iid: ctx.targets[0]!, player: ctx.controller };
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // Anon's Mom "Art" (FAITH): the DEF=7 discard cost was paid at activation; Special
  // Summon this card from the hand.
  "MJG-014:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // Mistakes into Miracles "Knot" (FAITH): the 6-ATK/9-DEF discard cost was paid at activation;
  // Special Summon this card from the hand.
  "MJG-WAN:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // Blood Sprout "Tra" (FAITH): the 7-ATK discard cost was paid at activation; Special Summon
  // this card from the hand.
  "MJG-410:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // Catbox "Upload" (FAITH): place this card AND the chosen non-Faith card (ctx.targets[0]) in the
  // shared Extra Zone; that card's ACTIVE then becomes usable by all players (see legalActions).
  "NYA-999:top": function* (ctx) {
    yield { kind: "moveToExtra", iid: ctx.self };
    if (ctx.targets[0]) yield { kind: "moveToExtra", iid: ctx.targets[0] };
  },
  // June 4th Incident "How did he know?" (FAITH): the serial-code search target was picked at
  // activation (ctx.targets[0]); add it to hand (search), shuffle, then Special Summon this card.
  "MJG-117633:top": function* (ctx) {
    const target = ctx.targets[0];
    if (!target) return;
    yield { kind: "moveToHand", iid: target, player: ctx.controller };
    yield { kind: "shuffleDeck" };
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // Blue-Eyes Ultimate Dragon "Polymerization" (FAITH): Special Summon by overlaying it on a
  // "Blue-Eyes White Dragon" (tucked beneath it).
  "MJG-C18:top": function* (ctx) {
    yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0]! };
  },
  // Freed Jyanshi (FAITH): Special Summon by overlaying it on any character (tucked beneath it).
  // The "cannot play cards from hand" lock + the 10-card self-discard are reducer/session-side.
  "MJG-000:top": function* (ctx) {
    yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0]! };
  },
  // Blue-Eyes Ultimate Dragon "De-Fusion" (Spell): this card was discarded and the chosen
  // "Blue-Eyes White Dragon" (up to 3, from hand/deck/discard) were gathered at activation;
  // Special Summon each, and shuffle the deck if any came from it (a deck search).
  "MJG-C18:bottom": function* (ctx) {
    const searchedDeck = ctx.targets.some((iid) => ctx.state().mainDeck.includes(iid));
    for (const iid of ctx.targets) yield { kind: "specialSummon", iid, controller: ctx.controller };
    if (searchedDeck) yield { kind: "shuffleDeck" };
  },
  // Mistakes into Miracles "Itadakimasu" (Active): Special Summon EVERY card in the banish pile
  // to your board (snapshot the pile first — each Special Summon removes a card from it).
  "MJG-WAN:bottom": function* (ctx) {
    for (const iid of [...ctx.state().banish]) yield { kind: "specialSummon", iid, controller: ctx.controller };
  },
  // ما شاء الله (FAITH): the matching-stat discard cost was paid at activation; Special
  // Summon this card from the hand (its summon trigger then wipes the boards).
  "MJG-016:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // ما شاء الله (when summoned): banish all OTHER face-up cards on all boards (protected
  // cards — Immunize / Supermodel / SOA opponents — are skipped by moveTo).
  "MJG-016:bottom": function* (ctx) {
    const s = ctx.state();
    const victims: string[] = [];
    for (const p of s.players) {
      for (const iid of p.board) {
        if (iid === ctx.self) continue;
        const ci = s.instances[iid];
        if (ci && !ci.faceDown && ci.cardId !== null) victims.push(iid);
      }
    }
    for (const iid of victims) yield { kind: "moveTo", iid, to: "banish" };
  },
  // Swordslut "Glorious Nippon Steel" (FAITH): Special Summon this card, then set the ATK
  // of every face-up opponent character to 0 until end of turn (SOA-protected ones are
  // skipped by statMod).
  "MJG-027:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
    const s = ctx.state();
    for (const p of s.players) {
      if (p.pid === ctx.controller || p.eliminated) continue;
      for (const iid of p.board) {
        const ci = s.instances[iid];
        if (ci && !ci.faceDown && ci.cardId !== null) yield { kind: "statMod", iid, stat: "atk", op: "set", amount: 0, duration: "endOfTurn" };
      }
    }
  },
  // HOLY MAHJONG "Resurrection" (FAITH): the 3-card hand cost was paid at activation;
  // Special Summon this card from the discard pile.
  "MJG-025:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // Resplendent Phoenix "Ashes" (FAITH): discard your entire hand + face-up board (face-down
  // cards stay — incl. this card itself, which goes to the discard); let all players Normal
  // Summon freely until your next turn ends; and schedule its return at your next turn start.
  "MJG-042:top": function* (ctx) {
    const s = ctx.state();
    const me = player(s, ctx.controller);
    // the hand is discarded in the PLAYER-CHOSEN order (ctx.targets, gathered at
    // resolution — see RESOLVE_CHOICES orderHand); any card not in the submitted
    // order (or a 0/1-card hand, which isn't prompted) falls back to hand order.
    const chosen = (ctx.targets ?? []).filter((t) => me.hand.includes(t));
    const rest = me.hand.filter((h) => !chosen.includes(h));
    const faceUps = me.board.filter((iid) => { const ci = s.instances[iid]; return !!ci && !ci.faceDown; });
    yield { kind: "discardOneByOne", iids: [...chosen, ...rest] }; // hand: pre-ordered by the player (orderHand)
    yield { kind: "discardOneByOne", iids: faceUps, chooser: ctx.controller }; // board: they order the wipe too
    yield { kind: "setUnlimitedSummon", player: ctx.controller };
    yield { kind: "scheduleStartTurnSummon", iid: ctx.self, player: ctx.controller };
  },
  // Resplendent Phoenix "Rebirth": when Special Summoned from the discard pile, draw 5.
  "MJG-042:bottom": drawN(5),
  // snek feet "Puberty" (FAITH): Special Summon this card by overlaying it on the targeted
  // [Cunny] (the [Cunny] is tucked beneath it on its owner's board).
  "MJG-048:top": function* (ctx) {
    yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0]! };
  },
  // snek feet "Snake Bite" (Active): give the targeted opponent a Poison counter; it takes
  // effect on their next turn (see the reducer — each card they play then costs hand cards).
  "MJG-048:bottom": function* (ctx) {
    const target = Number(ctx.targets[0]) as Seat;
    yield { kind: "playerCounter", player: target, counter: "poison", amount: 1 };
    yield { kind: "armPoison", player: target };
  },
  // Magical Sands "Depths of Hell" (FAITH): the 6-card hand banish was paid at activation;
  // Special Summon this card from the hand.
  "MJG-C13:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
  },
  // Magical Sands "The Second Hand" (Active): make a Special Meld from the 3 chosen discard
  // cards (they form a valid meld -> meldBoardCards, which draws the Faith card).
  "MJG-C13:bottom": function* (ctx) {
    const mats = ctx.targets.slice(0, 3);
    if (mats.length === 3) yield { kind: "meldBoard", player: ctx.controller, materials: mats };
  },
  // Waschizo "Post-War Showa Era" (FAITH): Special Summon by overlaying it on the targeted
  // battle-worn character (it is tucked beneath this card). ("WASHI NO IIPIN" draw is above.)
  "MJG-C14:top": function* (ctx) {
    yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0]! };
  },
  // Pizza Hut "C.C." (FAITH): Special Summon this card and place a Code counter on it. (Its
  // discard/banish-into-a-Code-counter replacement and the "Code" countdown are reducer-side.)
  "MJG-CC:top": function* (ctx) {
    yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
    yield { kind: "addCounter", iid: ctx.self, counter: "code", amount: 1 };
  },
  // The Cart Driver "L.L." (FAITH): Special Summon by overlaying it on "Pizza Hut".
  "MJG-ZERO:top": function* (ctx) {
    yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0]! };
  },
  // Spinzaku "Lancelot" (FAITH): Special Summon by overlaying it on any character (it is
  // tucked beneath this card). ("LIVE!" survival-redirect is reducer-side — see liveRedirect.)
  "MJG-C21:top": function* (ctx) {
    yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0]! };
  },
  // Sakurai "Guren" (FAITH): Special Summon by overlaying it on a [Type]-tag-less character
  // (tucked beneath it). ("Heaven's Gate" aura + leave-play wipe are reducer-side.)
  "MJG-C22:top": function* (ctx) {
    yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0]! };
  },
  // Strawberry Cup "Summon - Berserker" (FAITH): Special Summon by overlaying it on a character
  // you control (tucked beneath it; the ATK-gain is the MJG-C23:top aura). "Class Card"
  // (MJG-C23:bottom) is session-resolved like Belly Dance — no wrapper script here.
  "MJG-C23:top": function* (ctx) {
    yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0]! };
  },
  // Chocolate Cup "Twin Personality" (FAITH): Special Summon by overlaying it on a character
  // you control (tucked beneath it). It gains the overlaid cards' ATK/DEF (MJG-C25:top aura)
  // and abilities (abilityCardIds). "Mana Extraction" (MJG-C25:bottom) is session/reducer-side.
  "MJG-C25:top": function* (ctx) {
    yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0]! };
  },
  // Vanilla Cup "Summon - Caster" (FAITH): Special Summon by overlaying it on a character you
  // control (tucked beneath it; the DEF-gain is the MJG-C24:top aura).
  "MJG-C24:top": function* (ctx) {
    yield { kind: "overlaySummon", iid: ctx.self, onto: ctx.targets[0]! };
  },
  // Vanilla Cup "Holy Grail" (Active): the attach cost ran at activation; search the deck for
  // any card (gathered via RESOLVE_CHOICES choose:"deck" -> targets[0]), Special Summon it, and
  // shuffle the deck.
  "MJG-C24:bottom": function* (ctx) {
    if (ctx.targets[0]) yield { kind: "specialSummon", iid: ctx.targets[0], controller: ctx.controller };
    yield { kind: "shuffleDeck" };
  },
  // The Cart Driver "Geass" (Active): you control the targeted opponent's next turn. Only
  // once per game on the same player (enforced by geassTargets + the opponentFilter).
  "MJG-ZERO:bottom": function* (ctx) {
    const target = Number(ctx.targets[0]) as Seat;
    yield { kind: "armTurnControl", player: target, by: ctx.controller };
  },
  // Touch Fluffy Tail "Sacred Enjou" (Active): gain control of the targeted character, but
  // schedule it to be discarded at the end of this turn — one `and`-joined step.
  "MJG-036:bottom": function* (ctx) {
    const t = ctx.targets[0]!;
    yield { kind: "moveToBoard", iid: t, player: ctx.controller };
    yield { kind: "scheduleEndTurnDiscard", iid: t, player: ctx.controller };
  },
  // Crimson Chemist "A Worthy Disciple" (Active): resolve each chosen modal effect, encoded
  // at activation as "code:param" in ctx.targets (v=set VALUE, dd=discard opp by DEF,
  // ss=SS a hand card, sb=SS the discard bottom, dr=draw 1, fl=flip an opp face-down).
  "MJG-040:top": function* (ctx) {
    const ctrl = ctx.controller;
    for (const t of ctx.targets) {
      const [code, param] = t.split(":");
      const s = ctx.state();
      if (code === "v") yield { kind: "statMod", iid: ctx.self, stat: "value", op: "set", amount: Number(param), duration: "persistent" };
      else if (code === "dd") {
        const victims: string[] = [];
        for (const p of s.players) {
          if (p.pid === ctrl || p.eliminated) continue;
          for (const iid of p.board) { const ci = s.instances[iid]; if (ci && !ci.faceDown && ci.cardId != null && defOf(s, iid) === Number(param)) victims.push(iid); }
        }
        for (const pid of seatOrder(s.players.map((pp) => pp.pid), ctrl)) { // each owner orders their own
          const own = victims.filter((v) => player(s, pid).board.includes(v));
          if (own.length) yield { kind: "discardOneByOne", iids: own, chooser: pid };
        }
      } else if (code === "ss") {
        if (param && s.players.some((p) => p.hand.includes(param))) yield { kind: "specialSummon", iid: param, controller: ctrl };
      } else if (code === "sb") {
        const bottom = s.discard[s.discard.length - 1];
        if (bottom) yield { kind: "specialSummon", iid: bottom, controller: ctrl };
      } else if (code === "dr") {
        yield { kind: "draw", player: ctrl, count: 1 };
      } else if (code === "fl") {
        const owner = param ? s.players.find((p) => p.board.includes(param))?.pid : undefined;
        if (owner !== undefined) yield { kind: "flipDown", iid: param!, player: owner, until: "endOfThisTurn" };
      }
    }
  },
  // HOLY MAHJONG "New Covenant" (Active): banish this card (cost), then every living player
  // shuffles their hand and board into the deck and draws 5 (SOA-protected players keep
  // their cards and do not draw).
  "MJG-025:bottom": function* (ctx) {
    yield { kind: "moveTo", iid: ctx.self, to: "banish" };
    const s = ctx.state();
    for (const p of s.players) {
      if (p.eliminated) continue;
      for (const iid of [...p.board]) yield { kind: "shuffleIntoDeck", iid };
      yield { kind: "shuffleHandIntoDeck", player: p.pid };
    }
    for (const p of s.players) {
      if (p.eliminated) continue;
      yield { kind: "draw", player: p.pid, count: 5 };
    }
  },
  // Ojisan "Tactical Suppression": after this card battles, stun the character it fought
  // (targets[0]) until the end of its OWNER's next turn. If that character left play with
  // the battle (e.g. it was discarded), there is nothing to stun.
  "MJG-C28:bottom": function* (ctx) {
    const opp = ctx.targets[0];
    if (!opp) return;
    const s = ctx.state();
    if (!s.players.some((p) => p.board.includes(opp))) return;
    const owner = s.players.find((p) => p.board.includes(ctx.self))?.pid;
    if (owner === undefined) return;
    yield { kind: "stun", iid: opp, untilEndOfTurnOf: owner, nextTurn: true };
  },
  // DealinDemon "Noir Attack" (Passive, mandatory, after this card attacks): discard the (<=2)
  // characters adjacent to the original target — captured at battle resolution in pendingNoir
  // (empty unless DealinDemon was the attacker, so this no-ops when it merely defended).
  "MJG-C29:bottom": function* (ctx) {
    // "in any order": each victim's OWNER orders their own, one window per discard
    const s = ctx.state();
    const victims = [...s.pendingNoir];
    for (const pid of seatOrder(s.players.map((p) => p.pid), ctx.controller)) {
      const own = victims.filter((v) => player(s, pid).board.includes(v));
      if (own.length) yield { kind: "discardOneByOne", iids: own, chooser: pid };
    }
  },
};

/**
 * Trigger metadata: which game event fires an ability, parallel to CARD_SCRIPTS
 * (the script body lives there; this says WHEN it fires). Scope:
 *  - "eachTurn": end of ANY player's turn.
 *  - "controllerTurn": only at the end of the controller's own turn.
 * `optional` (You can ...) is an activation choice; deferred (we fire it for now).
 */
export interface CardTrigger {
  // effectToHand = the card reached the hand from the Main deck via a CARD EFFECT
  // (an effect draw or a non-draw add) — not the turn draw / starting hand.
  // discarded = this card went to the discard pile from a hand/board (any cause).
  // specialSummon = this card was SPECIAL Summoned (the Normal Summon doesn't fire it).
  // battle = this card fought a battle that resolved (win/lose/tie) and it survived.
  // summonFromDiscard = this card was Special Summoned out of the discard pile (Rebirth).
  on: "endOfTurn" | "summon" | "battleDiscard" | "battle" | "draw" | "meld" | "effectToHand" | "discarded" | "specialSummon" | "summonFromDiscard"; // more kinds (leavePlay/...) added later
  // endOfTurn: "eachTurn" | "controllerTurn" | "opponentTurn"; summon/battleDiscard/
  // draw/meld: "self"; opponentSummon: a board card reacts to an OPPONENT summoning on
  // their turn; opponentDraw: a HAND card reacts to an OPPONENT drawing (chains to it);
  // controllerMeld: a board card reacts to ITS controller making a meld (Winning Streak);
  // opponentDiscard: a board card reacts to an OPPONENT discarding on their turn (Call Slut).
  scope: "eachTurn" | "controllerTurn" | "opponentTurn" | "self" | "opponentSummon" | "opponentDraw" | "controllerMeld" | "opponentDiscard";
  optional?: boolean;
}
export const CARD_TRIGGERS: Record<string, CardTrigger> = {
  "MJG-014:bottom": { on: "endOfTurn", scope: "eachTurn", optional: true }, // Sprout
  "MJG-006:top": { on: "endOfTurn", scope: "controllerTurn" }, // Dnruk "Tipsy" (mandatory)
  "KSG-EMI:bottom": { on: "endOfTurn", scope: "controllerTurn" }, // Hotwheels "Trolley Problem" (mandatory)
  "MJG-C15:top": { on: "summon", scope: "self" }, // Ice Princess (mandatory)
  "MJG-044:top": { on: "summon", scope: "self" }, // Pon Yeehaw "Black or White" (mandatory)
  "MJG-045:top": { on: "summon", scope: "self" }, // Liyuean Opera "Ear Rape" (mandatory)
  "MJG-016:bottom": { on: "summon", scope: "self" }, // ما شاء الله: banish all other face-up cards
  "MJG-042:bottom": { on: "summonFromDiscard", scope: "self" }, // Resplendent Phoenix "Rebirth": draw 5
  "MJG-046:top": { on: "summon", scope: "self" }, // UNTZ "Party Hard" (mandatory)
  "FAT-009:top": { on: "summon", scope: "self" }, // Koko Doko "Koko!" (mandatory)
  "MJG-003:top": { on: "summon", scope: "self", optional: true }, // Cheese Chotto -> SS "TO Here"
  "MJG-018:top": { on: "summon", scope: "self", optional: true }, // Rigged Hands "Typical Haipai"
  "BAK-YOU:top": { on: "effectToHand", scope: "self", optional: true }, // Bnuuy "Watapon" (incl. effect draws)
  "BAK-YOU:bottom": { on: "summon", scope: "self", optional: true }, // Bnuuy "Book of Moon"
  "MJG-020:top": { on: "discarded", scope: "self" }, // G***u "Copestream" (mandatory)
  "MJG-013:top": { on: "draw", scope: "self", optional: true }, // Banana "Ehe…" -> SS on draw
  "MJG-013:bottom": { on: "meld", scope: "self", optional: true }, // Banana "RAKII" -> draw 2 when melded
  "MJG-M06:bottom": { on: "meld", scope: "self" }, // JOSP "TSUOM" (mandatory, melded from anywhere)
  "MJG-M09:bottom": { on: "specialSummon", scope: "self" }, // "Going to Gensokyo" (mandatory)
  "MJG-027:bottom": { on: "battleDiscard", scope: "self" }, // Swordslut "Banzai!"
  "MJG-037:bottom": { on: "battleDiscard", scope: "self" }, // AI(Steve) "Terminator"
  "MJG-C28:bottom": { on: "battle", scope: "self" }, // Ojisan "Tactical Suppression"
  "MJG-C29:bottom": { on: "battle", scope: "self" }, // DealinDemon "Noir Attack" (after it attacks)
  "MJG-M12:bottom": { on: "summon", scope: "opponentSummon" }, // "Second Amendment" (mandatory)
  "MJG-M12:top": { on: "draw", scope: "opponentDraw", optional: true }, // "fOUnD mEeEeee" — hand-trap on an opponent's draw
  "MJG-M23:top": { on: "endOfTurn", scope: "opponentTurn" }, // "Drop Trading" (mandatory): grab the top discard at each opponent's turn end
  "MJG-C04:bottom": { on: "meld", scope: "controllerMeld" }, // "Winning Streak" (mandatory): after YOU meld (not using this card)
  "MJG-C06:top": { on: "discarded", scope: "opponentDiscard", optional: true }, // "Call Slut": meld with an opponent's discard
};
export function getTrigger(cardId: string, role: string): CardTrigger | undefined {
  return CARD_TRIGGERS[`${cardId}:${role}`];
}

/**
 * Strict-PSCT step lists. An ability listed here resolves one STEP at a time so a
 * response window can open before a respondable step (`respondBefore` — true after
 * `then`/`;` or `.`/`next`, false for step 0 which the activation window covers, and
 * false after `and`/`also`/`if you do`). Source of truth: `CARD_SCRIPTS[key]` below
 * is derived from these (flattened) so `getScript` stays consistent.
 *
 * Only abilities with an inner respondable boundary BETWEEN STATE-CHANGING STEPS are
 * listed. A respondable connector that immediately follows leading targeting/cost
 * folds into the activation window (those abilities aren't listed — see
 * psct-steps.test.ts FOLDED_INTO_ACTIVATION).
 */
const ssSelfStep: EffectScript = function* (ctx) {
  yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller };
};
const drawStep = (n: number): EffectScript =>
  function* (ctx) { yield { kind: "draw", player: ctx.controller, count: n }; };

export const CARD_STEPS: Record<string, StepList> = {
  // CEOofLuckshitting "Monopoly" (FAITH): Special Summon this card; then (respondable `then`)
  // draw 5; then (respondable `then`) immediately end your turn (scheduleEndTurn -> the session
  // ends it once this resolution settles).
  "MJG-M05:top": [
    { run: function* (ctx) { yield { kind: "specialSummon", iid: ctx.self, controller: ctx.controller }; }, respondBefore: false },
    { run: function* (ctx) { yield { kind: "draw", player: ctx.controller, count: 5 }; }, respondBefore: true },
    { run: function* (ctx) { yield { kind: "scheduleEndTurn", player: ctx.controller }; }, respondBefore: true },
  ],
  // i can't believe toki is fucking dead "Futuristic Player": look at the top 3 of the
  // deck and add the chosen one to your hand (the other 2 stay on top in order); then
  // (respondable `then`) this card loses 1 DEF. The pick is gathered at resolution
  // (RESOLVE_CHOICES peekTop -> targets[0]). At 0 DEF the top passive discards it.
  "MJG-C05:bottom": [
    { run: function* (ctx) { if (ctx.targets[0]) yield { kind: "moveToHand", iid: ctx.targets[0], player: ctx.controller }; }, respondBefore: false },
    { run: function* (ctx) { yield { kind: "statMod", iid: ctx.self, stat: "def", op: "add", amount: -1, duration: "persistent" }; }, respondBefore: true },
  ],
  // Temeraire "Breast Expansion": discard this card; then (respondable `then`) EITHER
  // draw until you have 5 cards in hand, OR draw 2 — the mode is a resolution choice
  // (RESOLVE_CHOICES breastExpansion) written into targets[0] ("fill" | "two").
  "SOA-C02:top": [
    { run: function* (ctx) { yield { kind: "discard", iid: ctx.self }; }, respondBefore: false },
    {
      run: function* (ctx) {
        if (ctx.targets[0] === "two") {
          yield { kind: "draw", player: ctx.controller, count: 2 };
        } else {
          const need = 5 - player(ctx.state(), ctx.controller).hand.length;
          if (need > 0) yield { kind: "draw", player: ctx.controller, count: need };
        }
      },
      respondBefore: true,
    },
  ],
  // Pon Yeehaw "Black or White" (mandatory, on summon): set its VALUE to the chosen
  // ℕ (a persistent set-mod — it clears on leave-play, per the ruling); then
  // (respondable window) discard every face-up character with OPPOSITE parity
  // VALUE on every board, via the FAQ §9 forced-discard flow (☆s have no parity).
  "MJG-044:top": [
    {
      run: function* (ctx) {
        const n = Number(ctx.targets[0]);
        if (Number.isInteger(n) && n >= 1) yield { kind: "statMod", iid: ctx.self, stat: "value", op: "set", amount: n, duration: "persistent" };
      },
      respondBefore: false,
    },
    {
      run: function* (ctx) {
        const s = ctx.state();
        const n = Number(ctx.targets[0]);
        if (!Number.isInteger(n)) return;
        const parity = n % 2;
        const seating = s.seating.length ? [...s.seating] : s.players.map((p) => p.pid);
        const groups = seatOrder(seating, s.activePlayer)
          .map((pid) => {
            const p = s.players.find((x) => x.pid === pid);
            const iids = p && !p.eliminated
              ? p.board.filter((b) => {
                  const v = valueOf(s, b);
                  return !s.instances[b]?.faceDown && v !== null && v % 2 !== parity;
                })
              : [];
            return { player: pid, iids };
          })
          .filter((g) => g.iids.length > 0);
        if (groups.length) yield { kind: "forcedDiscard", groups };
      },
      respondBefore: true,
    },
  ],
  // FU-FU-FUCK SHAMIKO "keikumusume_0.png" (hand-trap vs a meld using the discard top):
  // SS this card; then (respondable `then`) negate that meld and Special Summon the
  // discard-pile material to YOUR board instead. ("Negated Normal Melds are used up" is
  // handled by the negateMeld intent.)
  "MJG-HAT:top": [
    { run: ssSelfStep, respondBefore: false },
    {
      run: function* (ctx) {
        const pm = ctx.state().pendingMeld;
        if (!pm) return;
        const stolen = pm.materials.find((m) => m === ctx.state().discard[0]); // the discard-pile material
        yield { kind: "negateMeld" };
        if (stolen) yield { kind: "specialSummon", iid: stolen, controller: ctx.controller };
      },
      respondBefore: true,
    },
  ],
  // The Hacker known as 4chan "BSoD": SS this card to the targeted opponent's board;
  // then (respondable `then`) banish a random card from that opponent's hand.
  "HTTP-404:top": [
    { run: function* (ctx) { yield { kind: "specialSummon", iid: ctx.self, controller: Number(ctx.targets[0]) as Seat }; }, respondBefore: false },
    { run: function* (ctx) { yield { kind: "banishRandom", player: Number(ctx.targets[0]) as Seat, count: 1 }; }, respondBefore: true },
  ],
  // I'm at the bar... "Siscon": steal the targeted weaker FEMALE to your hand;
  // then (respondable) Special Summon this card.
  "MJG-M02:top": [
    {
      run: function* (ctx) { if (ctx.targets[0]) yield { kind: "moveToHand", iid: ctx.targets[0], player: ctx.controller }; },
      respondBefore: false,
    },
    { run: ssSelfStep, respondBefore: true },
  ],
  // Senba Crow "SS": SS this card to the chosen PLAYER's board (board = control);
  // then (respondable) YOU draw 1.
  "MJG-M03:top": [
    {
      run: function* (ctx) { yield { kind: "specialSummon", iid: ctx.self, controller: Number(ctx.targets[0]) as Seat }; },
      respondBefore: false,
    },
    { run: drawStep(1), respondBefore: true },
  ],
  // Senba Crow "Hag Love": SS the chosen [Hag] from hand; then (respondable, and
  // `then`-dependent — no summon, no draw) draw 1.
  "MJG-M03:bottom": [
    {
      run: function* (ctx) { if (ctx.targets[0]) yield { kind: "specialSummon", iid: ctx.targets[0], controller: ctx.controller }; },
      respondBefore: false,
    },
    {
      run: function* (ctx) { if (ctx.targets[0]) yield { kind: "draw", player: ctx.controller, count: 1 }; },
      respondBefore: true,
    },
  ],
  // GrinchChads "Game Limit": discard this card; then shuffle the 2 targeted
  // (opponent, SS'd-this-turn) characters into the deck.
  "MJG-M10:top": [
    { run: function* (ctx) { yield { kind: "discard", iid: ctx.self }; }, respondBefore: false },
    {
      run: function* (ctx) { for (const t of ctx.targets) yield { kind: "shuffleIntoDeck", iid: t }; },
      respondBefore: true,
    },
  ],
  // GrinchChads "Grinch": draw 2; then shuffle this card into the deck.
  "MJG-M10:bottom": [
    { run: drawStep(2), respondBefore: false },
    { run: function* (ctx) { yield { kind: "shuffleIntoDeck", iid: ctx.self }; }, respondBefore: true },
  ],
  // SS this card; then draw N  (`then` → window before the draw)
  "MJG-001:top": [{ run: ssSelfStep, respondBefore: false }, { run: drawStep(1), respondBefore: true }],
  "MJG-C17:top": [{ run: ssSelfStep, respondBefore: false }, { run: drawStep(2), respondBefore: true }],
  "MJG-028:top": [{ run: ssSelfStep, respondBefore: false }, { run: drawStep(2), respondBefore: true }],
  // YUZU GRAPE "Correction": (target + SS = `and`) then banish the target
  "MJG-77*:top": [
    { run: ssSelfStep, respondBefore: false },
    { run: function* (ctx) { if (ctx.targets[0]) yield { kind: "moveTo", iid: ctx.targets[0], to: "banish" }; }, respondBefore: true },
  ],
  // TO Here "B&": discard this card; then place the target on the bottom of the deck
  "AS4-PIN:top": [
    { run: function* (ctx) { yield { kind: "discard", iid: ctx.self }; }, respondBefore: false },
    { run: function* (ctx) { if (ctx.targets[0]) yield { kind: "moveTo", iid: ctx.targets[0], to: "deckBottom" }; }, respondBefore: true },
  ],
  // TO Here "Thread Moved": place chosen discard on top; then you can return this to hand
  "AS4-PIN:bottom": [
    { run: function* (ctx) { if (ctx.targets[0]) yield { kind: "moveTo", iid: ctx.targets[0], to: "discardTop" }; }, respondBefore: false },
    { run: function* (ctx) { if (ctx.opt) yield { kind: "moveTo", iid: ctx.self, to: "hand" }; }, respondBefore: true },
  ],
  // JOSP "RAWN": discard this card; then place the target on the bottom of the discard pile
  "MJG-M06:top": [
    { run: function* (ctx) { yield { kind: "discard", iid: ctx.self }; }, respondBefore: false },
    { run: function* (ctx) { if (ctx.targets[0]) yield { kind: "moveTo", iid: ctx.targets[0], to: "discardBottom" }; }, respondBefore: true },
  ],
  // Literally Who? "Watson" effect (post-activation): banish that card; then draw 1.
  // targets[0] is set by the activation condition only when the VALUE guess matched.
  "MJG-012:bottom": [
    { run: function* (ctx) { if (ctx.targets[0]) yield { kind: "moveTo", iid: ctx.targets[0], to: "banish" }; }, respondBefore: false },
    { run: function* (ctx) { if (ctx.targets[0]) yield { kind: "draw", player: ctx.controller, count: 1 }; }, respondBefore: true },
  ],
  // Justice for Lalatano "ellisa_1.png" (hand-trap vs an activated draw effect):
  // SS this card; then negate that effect and discard that card (negate+discard
  // are `and`-joined — one simultaneous step). This is the PSCT spec's own chain
  // example (_psct_dump.txt R41-R45).
  "MJG-021:top": [
    { run: ssSelfStep, respondBefore: false },
    {
      run: function* (ctx) {
        const negated = yield { kind: "negateBelow", self: ctx.self };
        if (typeof negated === "string") yield { kind: "discard", iid: negated };
      },
      respondBefore: true,
    },
  ],
  // Touch Fluffy Tail "9 Tailed Fox" (FAITH): the top-9 discard shuffle was paid at
  // activation; Special Summon this card, then (after a window) gain control of all
  // face-up [Furry] characters on all boards.
  "MJG-036:top": [
    { run: ssSelfStep, respondBefore: false },
    {
      run: function* (ctx) {
        const s = ctx.state();
        const furries: string[] = [];
        for (const p of s.players) for (const iid of p.board) {
          const ci = s.instances[iid];
          if (ci && !ci.faceDown && ci.tribes.includes("Furry")) furries.push(iid);
        }
        for (const iid of furries) yield { kind: "moveToBoard", iid, player: ctx.controller };
      },
      respondBefore: true,
    },
  ],
  // Bravo "Fake News" (hand-trap vs an opponent's SPELL/ACTIVE activation):
  // discard this card; then negate that effect and discard that card (the same
  // shape as Lalatano — negate+discard are one `and`-joined simultaneous step).
  "MJG-026:top": [
    { run: function* (ctx) { yield { kind: "discard", iid: ctx.self }; }, respondBefore: false },
    {
      run: function* (ctx) {
        const negated = yield { kind: "negateBelow", self: ctx.self };
        if (typeof negated === "string") yield { kind: "discard", iid: negated };
      },
      respondBefore: true,
    },
  ],
  // Koito "Easily Startled" (hand-trap vs an activated effect that makes you show/reveal
  // cards in your hand): discard this card; then negate that effect and discard that card
  // (negate + discard are `and`-joined — one simultaneous step). Same shape as Fake News.
  "MJG-C31:top": [
    { run: function* (ctx) { yield { kind: "discard", iid: ctx.self }; }, respondBefore: false },
    {
      run: function* (ctx) {
        const negated = yield { kind: "negateBelow", self: ctx.self };
        if (typeof negated === "string") yield { kind: "discard", iid: negated };
      },
      respondBefore: true,
    },
  ],
  // Mooncakes "Emote Spam" (SPELL): "Add this card to their hand, then you draw 1"
  // — the `then` is a respondable boundary, so the draw is its own step. (WHO has
  // cast it is a public "Mooncake" player counter recorded at ACTIVATION.)
  "MOON-001:top": [
    {
      run: function* (ctx) {
        yield { kind: "moveToHand", iid: ctx.self, player: Number(ctx.targets[0]) as Seat };
      },
      respondBefore: false,
    },
    { run: function* (ctx) { yield { kind: "draw", player: ctx.controller, count: 1 }; }, respondBefore: true },
  ],
  // Counterspell "Mono Blue" (At any time, vs an activated SPELL): "You can discard
  // this card; Negate that SPELL and discard that card." — the same two-step shape
  // as Koito: cost discard first, then the `;`-respondable negate-and-discard.
  "MTG-001:top": [
    { run: function* (ctx) { yield { kind: "discard", iid: ctx.self }; }, respondBefore: false },
    {
      run: function* (ctx) {
        const negated = yield { kind: "negateBelow", self: ctx.self };
        if (typeof negated === "string") yield { kind: "discard", iid: negated };
      },
      respondBefore: true,
    },
  ],
  // No "Solem" (hand-trap vs an opponent playing a card): step 0 = discard one of your
  // melds (the cost; index chosen via RESOLVE_CHOICES ownMeldDiscard -> targets[0]); then
  // negate + discard that card (one `and` step); then, after a window, discard this card.
  // (Cannot be Negated is not separately enforced.)
  "MJG-C34:top": [
    {
      run: function* (ctx) {
        const idx = Number(ctx.targets[0] ?? "-1");
        if (idx >= 0) yield { kind: "discardMeld", player: ctx.controller, index: idx };
      },
      respondBefore: false,
    },
    {
      run: function* (ctx) {
        const negated = yield { kind: "negateBelow", self: ctx.self };
        if (typeof negated === "string") { yield { kind: "discard", iid: negated }; return; }
        // no chain link below: Solem chained to a SUMMON announcement — negate the
        // summon and destroy the summoned card (Solemn-Judgment style)
        const summoned = yield { kind: "negateSummon" };
        if (typeof summoned === "string") yield { kind: "discard", iid: summoned };
      },
      respondBefore: true,
    },
    { run: function* (ctx) { yield { kind: "discard", iid: ctx.self }; }, respondBefore: true },
  ],
  // GOTH "Call of Mastema": banish the chosen card from your hand (picked at
  // resolution via RESOLVE_CHOICES choose:"hand"); then draw 1. The draw is
  // `then`-dependent: no banish (e.g. empty hand at resolution) -> no draw.
  "MJG-022:bottom": [
    {
      run: function* (ctx) { if (ctx.targets[0]) yield { kind: "moveTo", iid: ctx.targets[0], to: "banish" }; },
      respondBefore: false,
    },
    {
      run: function* (ctx) { if (ctx.targets[0]) yield { kind: "draw", player: ctx.controller, count: 1 }; },
      respondBefore: true,
    },
  ],
  // Justice for Lalatano "Hitsuji ga Ippiki": draw 1 (+1 per previous use while in
  // play); then add 1 to the count. Sheep counters reset when the card leaves play.
  "MJG-021:bottom": [
    {
      run: function* (ctx) {
        const n = 1 + (ctx.state().instances[ctx.self]?.counters["sheep"] ?? 0);
        yield { kind: "draw", player: ctx.controller, count: n };
      },
      respondBefore: false,
    },
    {
      run: function* (ctx) { yield { kind: "addCounter", iid: ctx.self, counter: "sheep", amount: 1 }; },
      respondBefore: true,
    },
  ],
  // NEET "Exploiting Lonely Men": (target+SS are `and`-joined) SS this card; then
  // (respondable) the targeted opponent draws 1; and-then (no window) they give the
  // chosen hand card (gathered right before the step — RESOLVE_CHOICES give@2).
  "JONG-030:top": [
    { run: ssSelfStep, respondBefore: false },
    {
      run: function* (ctx) { yield { kind: "draw", player: Number(ctx.targets[0]) as Seat, count: 1 }; },
      respondBefore: true,
    },
    {
      run: function* (ctx) { if (ctx.targets[1]) yield { kind: "moveToHand", iid: ctx.targets[1], player: ctx.controller }; },
      respondBefore: false, // "and then" — simultaneous with the draw, no window
    },
  ],
  // Ninjutsu "Ninpo! Triplets no Jutsu!": SS this card; then (respondable) draw 3;
  // and-then (no window) shuffle the 3 chosen hand cards back into the deck (the
  // picks are gathered right before the step — RESOLVE_CHOICES handAtStep@2).
  "MJG-333:top": [
    { run: ssSelfStep, respondBefore: false },
    { run: drawStep(3), respondBefore: true },
    {
      run: function* (ctx) {
        for (const t of ctx.targets) yield { kind: "moveTo", iid: t, to: "deckTop" };
        if (ctx.targets.length) yield { kind: "shuffleDeck" };
      },
      respondBefore: false, // "and then" — simultaneous with the draw, no window
    },
  ],
  // i'm in your walls "fOUnD mEeEeee" (At any time): an optional hand-trap that chains
  // to an OPPONENT's draw (CARD_TRIGGERS opponentDraw). Accepting the trigger SS's this
  // card (step 0 = the "You can Special Summon"); then (respondable `then`) you can
  // attack a character the DRAWER controls, one-sided ("does not fight back" —
  // `and`-joined, folded into the attack). The optional attack + its victim are
  // gathered at resolution (a bespoke step-1 prompt keyed on script.drewBy):
  // ctx.opt = attack?, ctx.targets[0] = the victim.
  "MJG-M12:top": [
    { run: ssSelfStep, respondBefore: false },
    {
      run: function* (ctx) {
        if (ctx.opt && ctx.targets[0]) yield { kind: "effectAttack", attacker: ctx.self, target: ctx.targets[0], oneSided: true };
      },
      respondBefore: true,
    },
  ],
  // Koko Doko "Koko!": all opponents SS a random hand card; next, you draw 1 per summon.
  // The summoned count crosses the step boundary via ctx.scratch.
  "FAT-009:top": [
    {
      run: function* (ctx) {
        const s = ctx.state();
        const seating = s.seating.length ? [...s.seating] : s.players.map((p) => p.pid);
        const opps = seatOrder(seating, ctx.controller).filter((pid) => pid !== ctx.controller && !player(s, pid).eliminated);
        let summoned = 0;
        for (const pid of opps) { const got = yield { kind: "summonRandomFromHand", player: pid }; if (got) summoned++; }
        ctx.scratch.summoned = summoned;
      },
      respondBefore: false,
    },
    {
      run: function* (ctx) { const n = ctx.scratch.summoned ?? 0; if (n > 0) yield { kind: "draw", player: ctx.controller, count: n }; },
      respondBefore: true,
    },
  ],
};

/** Flatten a step list into one generator (all steps, in order) — used to derive
 *  the atomic `CARD_SCRIPTS` entry so single-script consumers stay consistent. */
function composeSteps(steps: StepList): EffectScript {
  return function* (ctx) {
    for (const s of steps) yield* s.run(ctx);
  };
}
// Derive the flat script for each step-wise ability (keeps getScript consistent).
for (const [key, steps] of Object.entries(CARD_STEPS)) CARD_SCRIPTS[key] = composeSteps(steps);

export function getScript(cardId: string, role: string): EffectScript | undefined {
  return CARD_SCRIPTS[`${cardId}:${role}`];
}

/** Ordered resolution steps for an ability: the authored `CARD_STEPS` list if any,
 *  else the single atomic script wrapped as one step, else `[]` (no runnable body). */
export function getSteps(cardId: string, role: string): StepList {
  const key = `${cardId}:${role}`;
  const authored = CARD_STEPS[key];
  if (authored) return authored;
  const sc = CARD_SCRIPTS[key];
  return sc ? [{ run: sc, respondBefore: false }] : [];
}

/**
 * Candidate targets a trigger may choose among when it is placed. Drives both the
 * legality gate (no candidates -> the optional trigger is not even offered) and
 * the player's choice (which copy). Triggers with no entry here take no target.
 */
export const TRIGGER_TARGETS: Record<string, (state: GameState, self: string, controller: Seat) => string[]> = {
  // Book of Moon: ANOTHER face-up character on any board (no candidates -> not offered)
  "BAK-YOU:bottom": (s, self) => {
    const out: string[] = [];
    for (const p of s.players) {
      if (p.eliminated) continue;
      for (const b of p.board) {
        if (b !== self && !s.instances[b]?.faceDown && s.instances[b]?.cardId !== null) out.push(b);
      }
    }
    return out;
  },
  // "TO Here" (AS4-PIN) copies in the controller's hand, the deck, or the discard
  "MJG-003:top": (s, _self, ctrl) => {
    const out: string[] = [];
    const me = s.players.find((p) => p.pid === ctrl);
    for (const zone of [me?.hand ?? [], s.mainDeck, s.discard]) {
      for (const iid of zone) if (s.instances[iid]?.cardId === "AS4-PIN") out.push(iid);
    }
    return out;
  },
};
export function triggerTargets(effectId: string, state: GameState, self: string, controller: Seat): string[] {
  return TRIGGER_TARGETS[effectId] ? TRIGGER_TARGETS[effectId]!(state, self, controller) : [];
}
/** Does this trigger declare a candidate set (so empty => illegal/not offered)? */
export function triggerNeedsTargets(effectId: string): boolean {
  return effectId in TRIGGER_TARGETS;
}
