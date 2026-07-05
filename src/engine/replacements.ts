/**
 * MJGTCG replacement effects ("… instead").
 *
 * A replacement modifies an event as it would happen, rather than responding
 * after it (FAQ R40). This slice covers MANDATORY battle-discard replacements:
 * when a card would be discarded by battle, an effect may change the outcome —
 * either DISCARD A DIFFERENT card, or MOVE the card somewhere other than the
 * discard pile. (Optional / from-hand replacements like Miko's SPELL respond in
 * the battle-discard window instead.)
 */
import type { GameState } from "./reducer.js";

const isLive = (s: GameState, iid: string) => !s.instances[iid]?.faceDown;

/** How a would-be battle discard is replaced (null = discard normally). */
export type BattleDiscardReplacement =
  | { kind: "discardInstead"; iid: string } // discard this OTHER card instead (the loser survives)
  | { kind: "moveInstead"; to: "deckTop" | "deckBottom" | "hand" | "banish" } // move the LOSER here instead of discarding
  | null;

/**
 * `iid` is about to be discarded by battle. Mandatory passives that change this:
 *  - Yuzu (MJG-029 "First for Yuzu!"): if the loser IS a face-up Yuzu, place it
 *    on top of the deck instead of discarding it.
 *  - Miko (UGR-005 "miko miko mii…"): if the loser's controller has a face-up
 *    Miko on board, that Miko is discarded instead (the loser survives).
 */
export function battleDiscardReplacement(state: GameState, iid: string): BattleDiscardReplacement {
  // Yuzu replaces its OWN discard (self-referential), so it takes precedence.
  if (isLive(state, iid) && state.instances[iid]?.cardId === "MJG-029") {
    return { kind: "moveInstead", to: "deckTop" };
  }
  const owner = state.players.find((p) => p.board.includes(iid))?.pid;
  if (owner === undefined) return null;
  const me = state.players.find((p) => p.pid === owner)!;
  const miko = me.board.find((b) => b !== iid && isLive(state, b) && state.instances[b]?.cardId === "UGR-005");
  return miko ? { kind: "discardInstead", iid: miko } : null;
}
