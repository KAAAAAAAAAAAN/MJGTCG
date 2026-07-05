import { describe, it, expect, beforeAll } from "vitest";
import * as M from "../engine/reducer.js";
import { computeAuras } from "../engine/auras.js";
import { GameSession, redactFor } from "./session.js";

const { replace } = M;
beforeAll(() => M.setAuraProvider(computeAuras));

const mk = (iid: string, over: Partial<M.CardInstance> = {}): M.CardInstance => ({
  iid, cardId: "", atk: 1, def: 1, value: 1, tribes: [], faceDown: false,
  tapped: false, counters: {}, overlays: [], battles: 0, mods: [], ...over,
});
/** 2-player game (empty hands) with crafted hand/board contents. */
function game(spec: { hand?: [number, M.CardInstance][]; board?: [number, M.CardInstance][] }): M.GameState {
  let s = M.newGame({ players: [0, 1], mainDeck: 12, faithDeck: 4, startingHand: 0 });
  for (const [, ci] of [...(spec.hand ?? []), ...(spec.board ?? [])])
    s = replace(s, { instances: { ...s.instances, [ci.iid]: ci } });
  for (const [pid, ci] of spec.hand ?? [])
    s = replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, hand: [...p.hand, ci.iid] } : p)) });
  for (const [pid, ci] of spec.board ?? [])
    s = replace(s, { players: s.players.map((p) => (p.pid === pid ? { ...p, board: [...p.board, ci.iid] } : p)) });
  return s;
}

describe("redactFor — hidden information", () => {
  it("shows the viewer's own hand but only counts for opponents", () => {
    const s = game({ hand: [[0, mk("myCard", { cardId: "MJG-001" })], [1, mk("oppCard", { cardId: "MJG-002" })]] });
    const v0 = redactFor(s, 0);
    const me = v0.players.find((p) => p.pid === 0)!;
    const opp = v0.players.find((p) => p.pid === 1)!;
    expect(me.hand?.map((c) => c.cardId)).toEqual(["MJG-001"]); // own hand visible
    expect(opp.hand).toBeUndefined(); // opponent hand not sent
    expect(opp.handCount).toBe(1); // ...only its size
  });

  it("never sends deck contents, only counts", () => {
    const s = game({});
    const v = redactFor(s, 0) as unknown as Record<string, unknown>;
    expect(v["mainDeck"]).toBeUndefined();
    expect(v["faithDeck"]).toBeUndefined();
    expect(redactFor(s, 0).mainDeckCount).toBe(12);
    expect(redactFor(s, 0).faithDeckCount).toBe(4);
  });

  it("face-up board cards are public; face-down identities are hidden from everyone", () => {
    const s = game({ board: [[1, mk("up", { cardId: "MJG-001", atk: 3 })], [1, mk("dn", { cardId: "MJG-002", faceDown: true })]] });
    const opp = redactFor(s, 0).players.find((p) => p.pid === 1)!;
    const up = opp.board.find((c) => c.iid === "up")!;
    const dn = opp.board.find((c) => c.iid === "dn")!;
    expect(up.cardId).toBe("MJG-001"); // face-up public
    expect(up.atk).toBe(3);
    expect(dn.cardId).toBeNull(); // face-down identity hidden
    expect(dn.faceDown).toBe(true);
  });

  it("board card stats reflect effective values (auras applied)", () => {
    // Mating (furry lord) + another furry -> +1/+1
    const s = game({ board: [[0, mk("lord", { cardId: "MJG-0w0", atk: 3, def: 3, tribes: ["Furry"] })], [0, mk("f", { tribes: ["Furry"] })]] });
    const me = redactFor(s, 0).players.find((p) => p.pid === 0)!;
    expect(me.board.find((c) => c.iid === "lord")!.atk).toBe(4);
  });

  it("discard and banish are public", () => {
    let s = game({});
    s = replace(s, { instances: { ...s.instances, d: mk("d", { cardId: "MJG-003" }) }, discard: ["d"] });
    expect(redactFor(s, 0).discard.map((c) => c.cardId)).toEqual(["MJG-003"]);
  });
});

describe("GameSession — seat authorization", () => {
  it("rejects acting as another player", () => {
    const sess = new GameSession(M.reduce(M.newGame({ players: [0, 1], mainDeck: 12 }), { type: M.ActionType.DRAW_RESOLVES }));
    const r = sess.apply(1, { type: M.ActionType.PLAYER_ACTS, player: 0, effectId: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot act as player 0/);
  });

  it("allows the owner to act, and surfaces reducer errors", () => {
    const sess = new GameSession(M.reduce(M.newGame({ players: [0, 1], mainDeck: 12 }), { type: M.ActionType.DRAW_RESOLVES }));
    expect(sess.apply(0, { type: M.ActionType.PLAYER_ACTS, player: 0, effectId: "x" }).ok).toBe(true);
    expect(sess.state.phase).toBe(M.Phase.ACTION_ANNOUNCED);
    // an illegal action surfaces the ReducerError as { ok:false, error }
    const bad = sess.apply(0, { type: M.ActionType.DRAW_RESOLVES });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/illegal/);
  });

  it("player-less flow actions are gated to the active player", () => {
    const sess = new GameSession(M.newGame({ players: [0, 1], mainDeck: 12 })); // active = 0, TURN_START_DRAW
    expect(sess.apply(1, { type: M.ActionType.DRAW_RESOLVES }).ok).toBe(false); // not active
    expect(sess.apply(0, { type: M.ActionType.DRAW_RESOLVES }).ok).toBe(true);
  });
});
