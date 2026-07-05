/**
 * MJGTCG triggered-effects collection.
 *
 * Given a game event, find the on-board abilities that trigger on it and return
 * them as `Trigger`s carrying a script ref. The caller feeds these to an
 * OPEN_TRIGGER_BATCH action, which orders them SEGOC (turn player first, then
 * anticlockwise) and places them on the chain to resolve via the effect runner.
 *
 * This slice implements the end-of-turn collector; later slices add collectors
 * for summon / leave-play / battle-discard / draw / meld events, all feeding the
 * same batch+chain pipeline. Wiring the reducer to fire these automatically at
 * phase boundaries is a separate orchestration step.
 */
import { isEffectNegated, valueOf, meldKind, abilityCardIds, type GameState, type TriggerEvent } from "./reducer.js";
import type { Trigger, Seat } from "./rules.js";
import { getTrigger } from "./card-scripts.js";

const ROLES = ["top", "bottom"] as const;

/** The triggers a board card `iid` has: its own, plus any it gains via Twin Personality
 *  (overlaid cards' triggers fire AS this card — self stays `iid`). For every non-Chocolate
 *  card this is just its own triggers, so behaviour is unchanged. */
function abilityTriggers(
  state: GameState,
  iid: string,
): { cardId: string; role: "top" | "bottom"; tg: NonNullable<ReturnType<typeof getTrigger>> }[] {
  const out: { cardId: string; role: "top" | "bottom"; tg: NonNullable<ReturnType<typeof getTrigger>> }[] = [];
  for (const cardId of abilityCardIds(state, iid)) {
    for (const role of ROLES) {
      const tg = getTrigger(cardId, role);
      if (tg) out.push({ cardId, role, tg });
    }
  }
  return out;
}

/** Collect triggers for a batch of emitted events (the injected TriggerCollector).
 *  This slice handles "summon" events with self-scope triggers; later slices add
 *  leave-play / battle-discard / draw / opponent-summon scopes. */
export function collectTriggers(state: GameState, events: readonly TriggerEvent[]): Trigger[] {
  const out: Trigger[] = [];
  // an effect-negated card (Shadow Clone / Antipsychotics) fires none of its own triggers
  const live = (iid: string) => !isEffectNegated(state, iid);
  for (const ev of events) {
    if (ev.kind === "summon") {
      // self-scope "when summoned" triggers fire on the summoned card itself
      if (live(ev.iid)) {
        for (const { cardId, role, tg } of abilityTriggers(state, ev.iid)) {
          if (tg.scope !== "self") continue;
          // on:"summon" fires on ANY summon; on:"specialSummon" only on Special Summons;
          // on:"summonFromDiscard" only when the card was Special Summoned from the discard.
          if (
            tg.on === "summon" ||
            (tg.on === "specialSummon" && ev.special === true) ||
            (tg.on === "summonFromDiscard" && ev.fromDiscard === true)
          ) {
            out.push({ player: ev.player, id: `${cardId}:${role}`, script: { cardId, role, self: ev.iid } });
          }
        }
      }
      // opponentSummon-scope (Second Amendment): a BOARD card reacts to an OPPONENT
      // summoning a character on THEIR turn. Fires for every live copy controlled by
      // someone other than the summoner; the summoned card is the trigger's target.
      if (ev.player === state.activePlayer) {
        for (const p of state.players) {
          if (p.eliminated || p.pid === ev.player) continue;
          for (const iid of p.board) {
            if (!live(iid)) continue;
            for (const { cardId: cid, role, tg } of abilityTriggers(state, iid)) {
              if (tg.on === "summon" && tg.scope === "opponentSummon") {
                out.push({ player: p.pid, id: `${cid}:${role}`, script: { cardId: cid, role, self: iid, targets: [ev.iid] } });
              }
            }
          }
        }
      }
    } else if (ev.kind === "battleDiscard") {
      // "After this card discards another character by battle:" -> the discarder
      if (!live(ev.discarder)) continue;
      for (const { cardId, role, tg } of abilityTriggers(state, ev.discarder)) {
        if (tg.on === "battleDiscard" && tg.scope === "self") {
          out.push({ player: ev.player, id: `${cardId}:${role}`, script: { cardId, role, self: ev.discarder } });
        }
      }
    } else if (ev.kind === "battle") {
      // "After this card battles:" (MJG-C28) -> fires for each surviving participant that
      // is still on a board; the OTHER participant is carried as targets[0].
      for (const [me, other] of [[ev.atk, ev.def], [ev.def, ev.atk]] as const) {
        const owner = state.players.find((p) => p.board.includes(me))?.pid;
        if (owner === undefined || !live(me)) continue; // left play / negated -> no trigger
        for (const { cardId, role, tg } of abilityTriggers(state, me)) {
          if (tg.on === "battle" && tg.scope === "self") {
            out.push({ player: owner, id: `${cardId}:${role}`, script: { cardId, role, self: me, targets: [other] } });
          }
        }
      }
    } else if (ev.kind === "draw" || ev.kind === "meld" || ev.kind === "toHand" || ev.kind === "discarded") {
      // opponentDraw-scope (fOUnD mEeEeee): a HAND card chains to an OPPONENT's draw —
      // fires for every opponent of the drawer holding such a card (the draw event is
      // what it responds to). The drawer is carried as `drewBy` for the attack target.
      // Skips the opening-hand deal: a hand-trap only responds from the first turn draw on.
      if (ev.kind === "draw" && !ev.opening) {
        for (const p of state.players) {
          if (p.eliminated || p.pid === ev.player) continue; // only OPPONENTS of the drawer
          for (const iid of p.hand) {
            const cid = state.instances[iid]?.cardId;
            if (!cid) continue;
            for (const role of ROLES) {
              const tg = getTrigger(cid, role);
              if (tg?.on === "draw" && tg.scope === "opponentDraw") {
                out.push({ player: p.pid, id: `${cid}:${role}`, script: { cardId: cid, role, self: iid, drewBy: ev.player } });
              }
            }
          }
        }
      }
      // "When you draw this card" / "If this card is melded" / "If you discard this
      // card" -> the drawn/melded/discarded card
      if (!live(ev.iid)) continue;
      for (const { cardId, role, tg } of abilityTriggers(state, ev.iid)) {
        if (tg.scope !== "self") continue;
        // "effectToHand" = the card reached the hand from the deck via a CARD
        // EFFECT: an effect draw (draw + byEffect) or a non-draw add (toHand).
        // A plain on:"draw" matches any real draw (turn draw included) but never
        // a toHand add — adding to hand is not drawing (MJG-021 ruling).
        // (a toHand event can never match a plain on:"draw"/"meld" — "toHand" is
        // not a CardTrigger.on kind, so the first comparison is false for it)
        const fires =
          tg.on === ev.kind ||
          (tg.on === "effectToHand" && (ev.kind === "toHand" || (ev.kind === "draw" && ev.byEffect === true)));
        if (fires) {
          out.push({ player: ev.player, id: `${cardId}:${role}`, script: { cardId, role, self: ev.iid } });
        }
      }
    }
  }
  // controllerMeld (Winning Streak): a board card fires ONCE when its controller makes a
  // meld (not using that card as a material — melded materials are already off the board).
  const meldEvents = events.filter((e) => e.kind === "meld");
  if (meldEvents.length > 0) {
    const melders = new Set(meldEvents.map((e) => (e as { player: Seat }).player));
    const meldedIids = new Set(meldEvents.map((e) => (e as { iid: string }).iid));
    for (const p of state.players) {
      if (p.eliminated || !melders.has(p.pid)) continue;
      for (const iid of p.board) {
        if (meldedIids.has(iid)) continue; // "not using this card"
        if (!live(iid)) continue;
        for (const { cardId: cid, role, tg } of abilityTriggers(state, iid)) {
          if (tg.on === "meld" && tg.scope === "controllerMeld") {
            out.push({ player: p.pid, id: `${cid}:${role}`, script: { cardId: cid, role, self: iid } });
          }
        }
      }
    }
  }
  // opponentDiscard (Call Slut): a board card reacts to an OPPONENT discarding a card on
  // their turn — optionally meld the discarded card + itself + 1 of its controller's
  // board/hand cards. Only offered when a completing card exists. The discarded card is
  // carried as the trigger's targets[0].
  for (const ev of events) {
    if (ev.kind !== "discarded" || ev.player !== state.activePlayer) continue; // "during their turn"
    const dv = valueOf(state, ev.iid);
    for (const p of state.players) {
      if (p.eliminated || p.pid === ev.player) continue; // opponents of the discarder
      for (const iid of p.board) {
        if (!live(iid)) continue;
        for (const { cardId: cid, role, tg } of abilityTriggers(state, iid)) {
          if (tg.on !== "discarded" || tg.scope !== "opponentDiscard") continue;
          const hasCompleter = [...p.board, ...p.hand].some((c) =>
            c !== iid && c !== ev.iid && (p.board.includes(c) ? !state.instances[c]?.faceDown : true) &&
            meldKind([dv, valueOf(state, iid), valueOf(state, c)]) !== null);
          if (!hasCompleter) continue;
          out.push({ player: p.pid, id: `${cid}:${role}`, script: { cardId: cid, role, self: iid, targets: [ev.iid] } });
        }
      }
    }
  }
  return out;
}

/** Triggers that fire at the end of `turnPlayer`'s turn, in board-scan order
 *  (OPEN_TRIGGER_BATCH applies SEGOC ordering). */
export function collectEndOfTurnTriggers(state: GameState, turnPlayer: Seat): Trigger[] {
  const out: Trigger[] = [];
  for (const p of state.players) {
    if (p.eliminated) continue;
    for (const iid of p.board) {
      if (isEffectNegated(state, iid)) continue; // negated: no triggers
      for (const { cardId, role, tg } of abilityTriggers(state, iid)) {
        if (tg.on !== "endOfTurn") continue;
        if (tg.scope === "controllerTurn" && p.pid !== turnPlayer) continue; // only the controller's own turn
        if (tg.scope === "opponentTurn" && p.pid === turnPlayer) continue; // only an OPPONENT's turn (Drop Trading)
        out.push({ player: p.pid, id: `${cardId}:${role}`, script: { cardId, role, self: iid } });
      }
    }
  }
  return out;
}
