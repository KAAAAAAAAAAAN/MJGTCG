/**
 * Manual ("Tabletop Simulator") session — a free-form sandbox with NO rules.
 *
 * Unlike GameSession (which enforces the full rules engine), this just holds zones
 * and card instances and applies direct manipulations any seated player may send at
 * any time (simultaneous, no turns). It mirrors the physical decks/discard/banish +
 * per-player hands and a free-position field, and produces a redacted per-seat view
 * (your own hand + face-down cards you control; opponents' hands and the decks are
 * hidden unless you are searching them).
 */
export type Seat = number;
export type ManualZone = "hand" | "board" | "mainDeck" | "faithDeck" | "discard" | "banish";

export interface ManualCard {
  iid: string;
  cardId: string; // the true id (redacted out of views when hidden)
  faceDown: boolean;
  tapped: boolean;
  counters: Record<string, number>;
  overlays: string[]; // iids tucked beneath this card (overlay)
  x: number; // free field position (board cards)
  y: number;
  targeted: boolean; // a transient "target" marker
}
export interface ManualState {
  players: { pid: Seat; hand: string[]; board: string[] }[];
  mainDeck: string[];
  faithDeck: string[];
  discard: string[];
  banish: string[];
  cards: Record<string, ManualCard>;
  // while a player is searching a pile, that pile's contents are revealed to them only.
  peeking: Record<Seat, { zone: ManualZone; count: number } | undefined>;
  log: string[];
}

/** Where a card is being moved. `pos` places it within an ordered pile (deck/discard);
 *  `x`/`y` place a board card on the field. */
export interface ManualDest {
  zone: ManualZone;
  player?: Seat; // for hand/board (defaults to the card's current owner, else seat 0)
  pos?: "top" | "bottom" | number; // for ordered piles
  x?: number;
  y?: number;
}
export type ManualAction =
  | { do: "move"; iid: string; to: ManualDest }
  | { do: "tap"; iid: string; value?: boolean }
  | { do: "flip"; iid: string; value?: boolean }
  | { do: "overlay"; iid: string; onto: string }
  | { do: "counter"; iid: string; name: string; delta: number }
  | { do: "target"; iid: string; value?: boolean }
  | { do: "shuffle"; zone: "mainDeck" | "faithDeck" | "discard" | "banish" }
  | { do: "draw"; player: Seat; zone: "mainDeck" | "faithDeck"; n?: number; faceDown?: boolean }
  | { do: "peek"; zone: ManualZone; count?: number; player?: Seat }
  | { do: "unpeek" }
  | { do: "reorder"; zone: "mainDeck" | "faithDeck" | "discard" | "banish"; order: string[] };

// ---- redacted views --------------------------------------------------------
export interface ManualCardView {
  iid: string;
  cardId: string | null; // null = hidden identity
  faceDown: boolean;
  tapped: boolean;
  counters: Record<string, number>;
  overlays: ManualCardView[];
  x: number;
  y: number;
  targeted: boolean;
}
export interface ManualView {
  viewer: Seat;
  players: { pid: Seat; handCount: number; hand: ManualCardView[] | null; board: ManualCardView[] }[];
  mainDeckCount: number;
  faithDeckCount: number;
  discard: ManualCardView[];
  banish: ManualCardView[];
  peek: { zone: ManualZone; cards: ManualCardView[] } | null;
  log: string[];
  names?: Record<number, string>; // seat -> nickname (decorated by GameRoom)
}

const ZONES: ManualZone[] = ["hand", "board", "mainDeck", "faithDeck", "discard", "banish"];

export class ManualSession {
  state: ManualState;

  constructor(state: ManualState) {
    this.state = state;
  }

  /** Build a fresh sandbox: shuffled shared decks, 5-card opening hands per seat. */
  static create(opts: { seats: Seat[]; main: string[]; faith: string[]; startingHand?: number; rng?: () => number }): ManualSession {
    const rng = opts.rng ?? Math.random;
    const sh = <T>(a: T[]): T[] => {
      const r = [...a];
      for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [r[i], r[j]] = [r[j]!, r[i]!]; }
      return r;
    };
    const cards: Record<string, ManualCard> = {};
    let n = 0;
    const mk = (cardId: string): string => {
      const iid = `m${n++}`;
      cards[iid] = { iid, cardId, faceDown: false, tapped: false, counters: {}, overlays: [], x: 0, y: 0, targeted: false };
      return iid;
    };
    const mainDeck = sh(opts.main).map(mk);
    const faithDeck = sh(opts.faith).map(mk);
    const players = opts.seats.map((pid) => ({ pid, hand: [] as string[], board: [] as string[] }));
    const hand = opts.startingHand ?? 5;
    for (const p of players) for (let i = 0; i < hand && mainDeck.length; i++) p.hand.push(mainDeck.shift()!);
    return new ManualSession({ players, mainDeck, faithDeck, discard: [], banish: [], cards, peeking: {}, log: [] });
  }

  private log(m: string): void {
    this.state = { ...this.state, log: [...this.state.log.slice(-80), m] };
  }
  private card(iid: string): ManualCard | undefined {
    return this.state.cards[iid];
  }
  private ownerOf(iid: string): Seat | undefined {
    for (const p of this.state.players) if (p.hand.includes(iid) || p.board.includes(iid)) return p.pid;
    return undefined;
  }
  /** Remove an iid from whatever zone holds it (does not touch overlays). */
  private detach(iid: string): void {
    const s = this.state;
    this.state = {
      ...s,
      mainDeck: s.mainDeck.filter((x) => x !== iid),
      faithDeck: s.faithDeck.filter((x) => x !== iid),
      discard: s.discard.filter((x) => x !== iid),
      banish: s.banish.filter((x) => x !== iid),
      players: s.players.map((p) => ({ ...p, hand: p.hand.filter((x) => x !== iid), board: p.board.filter((x) => x !== iid) })),
    };
  }
  private setCard(iid: string, patch: Partial<ManualCard>): void {
    const c = this.card(iid);
    if (!c) return;
    this.state = { ...this.state, cards: { ...this.state.cards, [iid]: { ...c, ...patch } } };
  }
  private name(iid: string): string {
    return this.card(iid)?.cardId || iid;
  }

  /** Apply an action from `seat` (any seated player, any time). Returns ok/error. */
  apply(seat: Seat, a: ManualAction): { ok: boolean; error?: string } {
    switch (a.do) {
      case "move": return this.move(seat, a.iid, a.to);
      case "tap": { const c = this.card(a.iid); if (!c) return { ok: false, error: "no such card" }; this.setCard(a.iid, { tapped: a.value ?? !c.tapped }); return { ok: true }; }
      case "flip": { const c = this.card(a.iid); if (!c) return { ok: false, error: "no such card" }; this.setCard(a.iid, { faceDown: a.value ?? !c.faceDown }); return { ok: true }; }
      case "target": { const c = this.card(a.iid); if (!c) return { ok: false, error: "no such card" }; this.setCard(a.iid, { targeted: a.value ?? !c.targeted }); return { ok: true }; }
      case "counter": { const c = this.card(a.iid); if (!c) return { ok: false, error: "no such card" }; const cur = (c.counters[a.name] ?? 0) + a.delta; const counters = { ...c.counters }; if (cur > 0) counters[a.name] = cur; else delete counters[a.name]; this.setCard(a.iid, { counters }); return { ok: true }; }
      case "overlay": return this.overlay(a.iid, a.onto);
      case "shuffle": return this.shuffle(a.zone);
      case "draw": return this.draw(a.player ?? seat, a.zone, a.n ?? 1, a.faceDown ?? false);
      case "peek": return this.peek(a.player ?? seat, a.zone, a.count);
      case "unpeek": this.state = { ...this.state, peeking: { ...this.state.peeking, [seat]: undefined } }; return { ok: true };
      case "reorder": return this.reorder(a.zone, a.order);
      default: return { ok: false, error: "unknown action" };
    }
  }

  private move(seat: Seat, iid: string, to: ManualDest): { ok: boolean; error?: string } {
    const c = this.card(iid);
    if (!c) return { ok: false, error: "no such card" };
    if (!ZONES.includes(to.zone)) return { ok: false, error: "bad zone" };
    // if this card is an overlay beneath another, lift it out first
    for (const [hid, h] of Object.entries(this.state.cards)) {
      if (h.overlays.includes(iid)) this.setCard(hid, { overlays: h.overlays.filter((x) => x !== iid) });
    }
    this.detach(iid);
    const s = this.state;
    if (to.zone === "hand" || to.zone === "board") {
      const pid = to.player ?? this.ownerOf(iid) ?? seat;
      const players = s.players.map((p) => {
        if (p.pid !== pid) return p;
        if (to.zone === "hand") {
          // numeric pos inserts at that index (drag-to-reorder); default appends
          const at = typeof to.pos === "number" ? Math.max(0, Math.min(p.hand.length, to.pos)) : p.hand.length;
          return { ...p, hand: [...p.hand.slice(0, at), iid, ...p.hand.slice(at)] };
        }
        return { ...p, board: [...p.board, iid] };
      });
      this.state = { ...s, players };
      if (to.zone === "board" && (to.x !== undefined || to.y !== undefined)) this.setCard(iid, { x: to.x ?? c.x, y: to.y ?? c.y });
      if (to.zone === "hand") this.setCard(iid, { faceDown: false, tapped: false, targeted: false }); // a card in hand is upright/untapped
    } else {
      const pile = s[to.zone] as string[];
      const at = to.pos === "bottom" ? pile.length : typeof to.pos === "number" ? Math.max(0, Math.min(pile.length, to.pos)) : 0; // default top
      const next = [...pile.slice(0, at), iid, ...pile.slice(at)];
      this.state = { ...s, [to.zone]: next } as ManualState;
      this.setCard(iid, { tapped: false, targeted: false, faceDown: to.zone === "mainDeck" || to.zone === "faithDeck" });
    }
    this.log(`${this.name(iid)} -> ${to.zone}${to.player !== undefined ? ` (p${to.player})` : ""}`);
    return { ok: true };
  }

  private overlay(iid: string, onto: string): { ok: boolean; error?: string } {
    const h = this.card(onto);
    if (!h || !this.card(iid) || iid === onto) return { ok: false, error: "bad overlay" };
    this.detach(iid);
    for (const [hid, hc] of Object.entries(this.state.cards)) if (hc.overlays.includes(iid)) this.setCard(hid, { overlays: hc.overlays.filter((x) => x !== iid) });
    this.setCard(onto, { overlays: [...h.overlays, iid] });
    this.log(`${this.name(iid)} overlaid beneath ${this.name(onto)}`);
    return { ok: true };
  }

  private shuffle(zone: "mainDeck" | "faithDeck" | "discard" | "banish"): { ok: boolean; error?: string } {
    const a = [...(this.state[zone] as string[])];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
    this.state = { ...this.state, [zone]: a } as ManualState;
    this.log(`${zone} shuffled`);
    return { ok: true };
  }

  private draw(player: Seat, zone: "mainDeck" | "faithDeck", n: number, faceDown: boolean): { ok: boolean; error?: string } {
    for (let i = 0; i < n; i++) {
      const pile = this.state[zone] as string[];
      if (pile.length === 0) break;
      const iid = pile[0]!;
      this.move(player, iid, { zone: "hand", player });
      if (faceDown) this.setCard(iid, { faceDown: true });
    }
    this.log(`p${player} draws ${n} from ${zone}`);
    return { ok: true };
  }

  private peek(player: Seat, zone: ManualZone, count?: number): { ok: boolean; error?: string } {
    const pile = (this.state as unknown as Record<string, string[]>)[zone];
    if (!Array.isArray(pile)) return { ok: false, error: "not a searchable pile" };
    this.state = { ...this.state, peeking: { ...this.state.peeking, [player]: { zone, count: count ?? pile.length } } };
    return { ok: true };
  }

  private reorder(zone: "mainDeck" | "faithDeck" | "discard" | "banish", order: string[]): { ok: boolean; error?: string } {
    const cur = this.state[zone] as string[];
    const isPerm = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    // full permutation, or a PREFIX reorder: `order` permutes just the top N cards
    // (so reordering a top-N deck search works without knowing the hidden rest).
    let next: string[] | null = null;
    if (isPerm(order, cur)) next = [...order];
    else if (order.length > 0 && order.length < cur.length && isPerm(order, cur.slice(0, order.length))) next = [...order, ...cur.slice(order.length)];
    if (!next) return { ok: false, error: "order must be a permutation" };
    this.state = { ...this.state, [zone]: next } as ManualState;
    this.log(`${zone} reordered`);
    return { ok: true };
  }

  // ---- view ----------------------------------------------------------------
  private cv(iid: string, opts: { reveal: boolean }): ManualCardView {
    const c = this.card(iid)!;
    return {
      iid,
      cardId: opts.reveal ? c.cardId : null,
      faceDown: c.faceDown,
      tapped: c.tapped,
      counters: c.counters,
      overlays: c.overlays.map((o) => this.cv(o, { reveal: true })), // overlay materials are public
      x: c.x,
      y: c.y,
      targeted: c.targeted,
    };
  }
  /** Redacted view for `seat`: own hand + own face-down cards revealed; opponents' hands and the
   *  decks hidden (unless `seat` is peeking that pile). */
  viewFor(seat: Seat): ManualView {
    const s = this.state;
    const peek = s.peeking[seat];
    const players = s.players.map((p) => ({
      pid: p.pid,
      handCount: p.hand.length,
      hand: p.pid === seat ? p.hand.map((iid) => this.cv(iid, { reveal: true })) : null,
      // board: face-up is public; a face-down card is revealed only to its controller
      board: p.board.map((iid) => this.cv(iid, { reveal: !this.card(iid)!.faceDown || p.pid === seat })),
    }));
    const peekZone = peek ? ((s as unknown as Record<string, string[]>)[peek.zone] ?? []).slice(0, peek.count) : null;
    return {
      viewer: seat,
      players,
      mainDeckCount: s.mainDeck.length,
      faithDeckCount: s.faithDeck.length,
      discard: s.discard.map((iid) => this.cv(iid, { reveal: true })),
      banish: s.banish.map((iid) => this.cv(iid, { reveal: true })),
      peek: peek && peekZone ? { zone: peek.zone, cards: peekZone.map((iid) => this.cv(iid, { reveal: true })) } : null,
      log: s.log.slice(-40),
    };
  }
}
