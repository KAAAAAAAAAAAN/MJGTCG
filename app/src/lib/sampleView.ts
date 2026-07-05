import type { SeatView, CardView } from "@net/session.js";

// A representative board, shown before connecting so the layout is visible
// (and screenshot-able) without an open socket.
const c = (iid: string, cardId: string, atk: number, def: number, value: number | null, extra: Partial<CardView> = {}): CardView => ({
  iid, cardId, atk, def, value, ...extra,
});

export const sampleView: SeatView = {
  viewer: 0,
  phase: "MAIN_PHASE",
  activePlayer: 0,
  // demo legal options (a real game gets these from the server)
  legal: [
    { kind: "endTurn" },
    { kind: "normalSummon", iid: "h1" },
    { kind: "normalSummon", iid: "h2" },
    { kind: "normalSummon", iid: "h3" },
    { kind: "normalSummon", iid: "h4" },
    { kind: "normalSummon", iid: "h5" },
    { kind: "normalSummon", iid: "h6" },
  ],
  awaiting: false,
  choice: null,
  toggle: "off",
  arrange: false,
  bonds: [],
  prioritySeat: null,
  winner: null,
  chainDepth: 0,
  stack: [],
  pendingEvents: 0,
  pending: { battle: null, targets: [], targetSeats: [], discards: [], meld: null },
  seating: [0, 1],
  mainDeckCount: 58,
  deckTop: null,
  deckFlipped: false,
  faithTop: null,
  revealedHands: [],
  faithDeckCount: 17,
  discard: [c("d1", "MJG-003", 1, 3, 3), c("d2", "MJG-006", 4, 2, 3)],
  banish: [c("b1", "MJG-005", 0, 0, 5)],
  extraZone: [],
  players: [
    {
      pid: 0,
      eliminated: false,
      handCount: 6,
      boardPages: 1,
      hand: [
        c("h1", "MJG-001", 1, 1, 1),
        c("h2", "MJG-013", 2, 2, 2),
        c("h3", "MJG-C15", 1, 5, 5),
        c("h4", "MJG-027", 3, 7, 5),
        c("h5", "MJG-0w0", 4, 4, 1),
        c("h6", "MJG-888", 3, 1, 3),
      ],
      board: [c("m-ai", "MJG-037", 7, 3, 5, { tapped: true }), c("m-oji", "MJG-C28", 1, 5, 5), c("m-har", "MJG-011", 1, 1, 1)],
      meldZone: [{ kind: "triplet", kan: false, cards: [c("z1", "MJG-011", 1, 1, 5), c("z2", "MJG-013", 2, 2, 5), c("z3", "MJG-027", 3, 7, 5)] }],
    },
    {
      pid: 1,
      eliminated: false,
      handCount: 5,
      boardPages: 1,
      board: [c("o1", "MJG-002", 2, 2, 2), { iid: "o2", cardId: null, faceDown: true }],
      meldZone: [],
    },
  ],
  log: [
    "player 0 normal summons m-ai (MJG-037) -> board; window opens",
    "chain fully resolved -> MainPhase",
    "player 0 drew m-12 (mainDeck=58,hand=6)",
  ],
};
