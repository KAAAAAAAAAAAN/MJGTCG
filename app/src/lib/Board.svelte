<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Card from "./Card.svelte";
  import CardSlot from "./CardSlot.svelte";
  import CardDetail from "./CardDetail.svelte";
  import PileViewer from "./PileViewer.svelte";
  import MeldViewer from "./MeldViewer.svelte";
  import LogViewer from "./LogViewer.svelte";
  import ReorderViewer from "./ReorderViewer.svelte";
  import DevPanel from "./DevPanel.svelte";
  import type { SeatView, Command, Response, ChainToggle, Choice, FreeAction, BoardAction } from "@net/session.js";
  import type { CardView } from "@net/session.js";
  import type { LegalAction } from "@engine/legal.js";
  import { canExtendMeld, meldAssignments } from "@engine/reducer.js";
  import baseSet from "@root/base_set.json";
  import manifest from "@root/manifest.json";

  export let view: SeatView;
  export let selected: string | null = null;
  let targeting: string | null = null; // attacker awaiting a target (Board-local)
  let kanning: Extract<LegalAction, { kind: "kan" }> | null = null; // a KAN awaiting its 4th-card pick
  let activating: { iid: string; role: string; as?: string; need: number; kind: "character" | "discard" | "opponent" | "player"; picked: string[]; respond?: boolean; targetIds?: string[]; targetSeats?: number[] } | null = null; // activation awaiting target(s) (respond = chain it into the open window); as = granting cardId (Twin Personality); targetIds/targetSeats = server-computed valid targets
  let melding = false; // meld-selection mode (Board-local)
  let meldMode: "board" | "hand" = "board"; // board+discard meld, or a from-hand special meld (>dama)
  let meldActive: string | null = null; // the on-board active driving a hand meld
  let meldSel: string[] = []; // chosen meld materials (iids), in pick order
  let meldChoices: number[][] | null = null; // candidate ☆-value assignments awaiting the player's pick
  $: boardMelding = melding && meldMode === "board";
  $: handMelding = melding && meldMode === "hand";
  let hovered: CardView | null = null; // card under the cursor (for the detail panel)
  let scryPreview: CardView | null = null; // a pinned card preview (Fortune Teller link)
  let viewPile: "discard" | "banish" | null = null; // open pile viewer (Master-Duel-style)
  let viewOverlaid: CardView | null = null; // a board card whose overlaid cards are being inspected
  let viewMelds: number | null = null; // pid whose melds are open in the viewer
  let viewLog = false; // game-log popup

  // ---- free-position boards --------------------------------------------------
  // Positions are SERVER state (logical units: card 100×139, rows of 7, wrap-below
  // by 35): they feed the positional effects (Noir Attack / Explosive Aria), so
  // every viewer sees the owner's arrangement. Pages are added manually with "+";
  // the viewer flips through any board's pages. Cards without a position (older
  // states) fall back to their flow slot.
  const GEOM = { cols: 7, xStep: 100, yStep: 35, maxX: 660, maxY: 105, W: 770 };
  type Placed = { c: CardView; x: number; y: number; page: number };
  const placed = (board: CardView[], pg: number): Placed[] =>
    board
      .map((c, i) => ({ c, x: c.pos?.x ?? (i % GEOM.cols) * GEOM.xStep, y: c.pos?.y ?? Math.floor(i / GEOM.cols) * GEOM.yStep, page: c.pos?.page ?? 0 }))
      .filter((p) => p.page === pg);
  let boardPage: Record<number, number> = {};
  // "+" is offered only when every existing page holds 4+ cards (server-enforced too)
  $: canAddPage = !!me && (me.boardPages ?? 1) < 9
    && Array.from({ length: me.boardPages ?? 1 }, (_, pg) => placed(me.board, pg).length).every((n) => n >= 4);
  function setPage(pid: number, pg: number, own = false) {
    boardPage = { ...boardPage, [pid]: pg };
    if (own) dispatch("board", { do: "view", page: pg }); // steers future auto-placements
  }
  // "Move" button: pick the card up (it follows the mouse); the next click drops
  // it right there. Escape cancels (the card snaps back).
  let boardEl: HTMLDivElement | null = null;
  let probeEl: HTMLSpanElement | null = null; // 1-card-wide ruler: real px per --cw
  let carry: { iid: string; px: number; py: number } | null = null;
  function startCarry(iid: string) {
    if (carry || !me) return;
    const pg = Math.min(boardPage[me.pid] ?? 0, me.boardPages - 1);
    const pcd = placed(me.board, pg).find((p) => p.c.iid === iid);
    if (!pcd) return;
    selected = null; // close the action popup
    carry = { iid, px: pcd.x, py: pcd.y };
    window.addEventListener("pointermove", carryMove);
    window.addEventListener("pointerdown", carryDrop, true);
    window.addEventListener("keydown", carryKey, true);
  }
  function carryMove(e: PointerEvent) {
    if (!carry || !boardEl || !me) return;
    const r = boardEl.getBoundingClientRect();
    // positions render in --cw units, so convert the mouse the same way (the
    // container itself may be clamped narrower than 7.7 card widths)
    const cwPx = probeEl?.getBoundingClientRect().width || r.width / 7.7;
    const k = 100 / Math.max(1, cwPx);
    let nx = (e.clientX - r.left) * k - 50; // card centred under the cursor
    const ny = (e.clientY - r.top) * k - 70;
    const pg = Math.min(boardPage[me.pid] ?? 0, me.boardPages - 1);
    // carrying past an edge hops to the adjacent page; with no page that way the border clamps
    if (nx > GEOM.maxX + 45 && pg < me.boardPages - 1) { setPage(me.pid, pg + 1, true); nx = 0; }
    else if (nx < -45 && pg > 0) { setPage(me.pid, pg - 1, true); nx = GEOM.maxX; }
    carry = { iid: carry.iid, px: Math.max(0, Math.min(nx, GEOM.maxX)), py: Math.max(0, Math.min(ny, GEOM.maxY)) };
  }
  function carryDrop(e: PointerEvent) {
    e.stopPropagation(); // no preventDefault: it can suppress the very click we swallow
    window.addEventListener("click", swallowClick, true); // eat the click this drop produces
    window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 600); // never outlives the drop
    if (carry && me) {
      const pg = Math.min(boardPage[me.pid] ?? 0, me.boardPages - 1);
      dispatch("board", { do: "move", iid: carry.iid, x: Math.round(carry.px), y: Math.round(carry.py), page: pg });
    }
    endCarry();
  }
  function carryKey(e: KeyboardEvent) {
    if (e.key === "Escape" && carry) { e.stopPropagation(); endCarry(); } // cancel: snaps back
  }
  function endCarry() {
    window.removeEventListener("pointermove", carryMove);
    window.removeEventListener("pointerdown", carryDrop, true);
    window.removeEventListener("keydown", carryKey, true);
    carry = null;
  }
  function swallowClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    window.removeEventListener("click", swallowClick, true);
  }
  // ---- Explosive Aria placement: the picked card rides the mouse; only a click
  // ON A BOARD AREA places it (deck, piles and UI clicks don't count). ----
  $: ariaPlace = view.choice?.placeCard ?? null;
  let ariaXY = { x: -9999, y: -9999 };
  let ariaSent = false;
  let ariaArmed = false;
  $: if (ariaPlace && !ariaArmed) {
    ariaArmed = true;
    ariaSent = false;
    window.addEventListener("pointermove", ariaMove);
    window.addEventListener("click", ariaClick, true);
  } else if (!ariaPlace && ariaArmed) {
    ariaArmed = false;
    window.removeEventListener("pointermove", ariaMove);
    window.removeEventListener("click", ariaClick, true);
  }
  function ariaMove(e: PointerEvent) {
    ariaXY = { x: e.clientX, y: e.clientY };
  }
  function ariaClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault(); // placement clicks never leak into the game UI
    if (ariaSent) return;
    const hit = (document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[]).find((n) => n.dataset && n.dataset.seat !== undefined);
    if (!hit) return; // not over a board — doesn't count
    const seat = Number(hit.dataset.seat);
    const sl = hit.dataset.slot ?? "";
    const rect = hit.getBoundingClientRect();
    const cwPx = probeEl?.getBoundingClientRect().width || rect.width / 7.7;
    const k = 100 / Math.max(1, cwPx);
    let lx: number, ly: number;
    if (sl === "left") { lx = (e.clientY - rect.top) * k - 50; ly = (e.clientX - rect.left) * k - 70; }
    else if (sl === "right") { lx = (e.clientY - rect.top) * k - 50; ly = (rect.right - e.clientX) * k - 70; }
    else { lx = (e.clientX - rect.left) * k - 50; ly = (e.clientY - rect.top) * k - 70; }
    const tp = view.players.find((pl) => pl.pid === seat);
    const pg = Math.min(boardPage[seat] ?? 0, (tp?.boardPages ?? 1) - 1);
    ariaSent = true;
    dispatch("choose", { use: true, place: { seat, x: Math.round(Math.max(0, Math.min(lx, GEOM.maxX))), y: Math.round(Math.max(0, Math.min(ly, GEOM.maxY))), page: pg } });
  }
  // the hand pages the same way (max 10 per page)
  const HAND_PAGE = 10;
  let handPage = 0;
  function flipHand(dir: number, total: number) {
    const pc = Math.max(1, Math.ceil(total / HAND_PAGE));
    handPage = Math.max(0, Math.min(pc - 1, Math.min(handPage, pc - 1) + dir));
  }

  // ---- mahjong seat placement: viewer is always at the bottom; opponents are
  // placed around the table by their turn-offset, rotated to face their seat. ----
  const SLOTS: Record<number, Record<number, string>> = {
    2: { 1: "top" },
    3: { 1: "right", 2: "top" },
    4: { 1: "right", 2: "top", 3: "left" },
  };
  function slotFor(pid: number): string {
    const order = view.seating.length ? [...view.seating] : view.players.map((p) => p.pid);
    const n = order.length;
    // anticlockwise distance from the viewer: turns pass to the right first
    // (next player -> right slot), so play reads anticlockwise round the table
    const off = (order.indexOf(view.viewer) - order.indexOf(pid) + n) % n;
    return (SLOTS[n] ?? SLOTS[4])![off] ?? "top";
  }

  // The detail panel shows ONLY the hovered card — clicking a card no longer pins
  // it open (which used to cover cards you were about to target).
  $: detailCard = scryPreview ?? hovered;
  $: if (!view.choice?.preview) scryPreview = null; // clear when the prompt closes

  const dispatch = createEventDispatcher<{ select: string; command: Command; respond: Response; setToggle: ChainToggle; devSpawn: string; choose: Choice; free: FreeAction; board: BoardAction }>();

  // ---- Free mode (dev sandbox): click any visible card -> direct zone actions ------
  let freeMode = false;
  let freeMenu: string | null = null; // iid whose free-action bar is open
  let freeSel: string[] = []; // cards picked for a free meld (outlined)
  function toggleFree() { freeMode = !freeMode; freeMenu = null; freeSel = []; }
  $: if (!view.cheats && freeMode) { freeMode = false; freeMenu = null; freeSel = []; } // no cheats -> no free clicks
  const openFree = (iid: string) => (freeMenu = freeMenu === iid ? null : iid);
  function freeAct(a: FreeAction) { dispatch("free", a); freeMenu = null; }
  function freeMeldPick(iid: string) {
    freeSel = freeSel.includes(iid) ? freeSel.filter((x) => x !== iid) : freeSel.length < 3 ? [...freeSel, iid] : freeSel;
    freeMenu = null;
  }
  function freeMeldConfirm() { dispatch("free", { do: "meld", materials: [...freeSel] }); freeSel = []; }
  const CARD = new Map((baseSet as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const ABIL = new Map((baseSet as { id: string; abilities?: { role: string; title?: string }[] }[]).map((c) => [c.id, c]));
  function effectLabel(eid: string): string {
    const [id, role] = eid.split(":");
    const c = id ? ABIL.get(id) : undefined;
    const title = c?.abilities?.find((a) => a.role === role)?.title;
    return `${(id && CARD.get(id)) || id}${title ? " — " + title : ""}`;
  }
  const MAN = manifest as Record<string, { image?: string }>;
  const nameOf = (c: CardView) => (c.cardId ? (CARD.get(c.cardId) ?? c.cardId) : "");
  const frontOf = (c: CardView) => (c.cardId && MAN[c.cardId]?.image ? `/${MAN[c.cardId]!.image}` : undefined);
  const isBig = (c: CardView) => c.cardId === "NYA-000"; // BIG ICHIHIME renders 2× on the board
  const PCTR: Record<string, string> = { Clown: "🤡", Mooncake: "🥮" }; // player-counter icons
  const pname = (pid: number) => view.names?.[pid] ?? `P${pid}`; // nickname, else P#

  $: me = view.players.find((p) => p.pid === view.viewer);
  $: opponents = view.players.filter((p) => p.pid !== view.viewer);
  $: globalActions = view.legal.filter((a) => !("iid" in a)); // draw / endTurn / advance / meld
  const actionsFor = (iid: string) => view.legal.filter((a): a is Extract<LegalAction, { iid: string }> => "iid" in a && a.iid === iid);
  // A modal interaction is in progress (targeting an effect, attacking, melding,
  // or answering an optional-effect prompt): only the controls relevant to that
  // interaction stay live — every other action click is suppressed.
  $: busy = !!activating || !!targeting || melding || !!view.choice || !!kanning;
  // KAN material pick: the valid 4th cards, clicked directly (board / hand / discard top)
  $: kanIds = kanning ? new Set(kanning.materialIds) : new Set<string>();
  function pickKan(iid: string) {
    if (!kanning || !kanIds.has(iid)) return;
    dispatch("command", { do: "kan", meldIndex: kanning.meldIndex, material: iid });
    kanning = null;
  }
  // activatable-from-the-discard-pile effects (Resurrection, MJG-025), surfaced as
  // "Activate" buttons in the discard viewer. Suppressed during a modal interaction.
  $: discardActs = busy ? {} : view.legal.reduce((m, a) => {
    if (a.kind === "activate" && a.from === "discard") (m[a.iid] ??= []).push(a);
    return m;
  }, {} as Record<string, Extract<LegalAction, { kind: "activate" }>[]>);

  const select = (iid: string) => dispatch("select", iid);
  /** Route a chosen card action: a respond if a window is awaiting us, else a command. */
  function act(a: LegalAction) {
    // A hand-pick decision is active: every shown action is the synthetic pick
    // button (discard/reveal/banish) — answer the choice with that card.
    if (handPick) {
      dispatch("choose", { use: true, target: (a as unknown as { iid: string }).iid });
      return;
    }
    // Activations that need target(s) must run the picker FIRST — whether activated
    // from the main phase (command) or as a response to an open window (respond).
    // Firing a response without its targets crashes resolution. ("choose"/"you can"
    // decisions are made later, at resolution, via the choice prompt.)
    if (a.kind === "activate" && !a.handMeld && a.targets > 0) {
      const responding = !!view.awaiting;
      // single forced opponent target -> resolve immediately, no picker
      if ((a.targetKind === "opponent" || a.targetKind === "player") && a.targets === 1 && (a.targetSeats ?? opponents.map((o) => o.pid)).length === 1) {
        finishActivate(a.iid, a.role, [String((a.targetSeats ?? opponents.map((o) => o.pid))[0])], responding, a.as);
        return;
      }
      activating = { iid: a.iid, role: a.role, as: a.as, need: a.targets, kind: a.targetKind ?? "character", picked: [], respond: responding, targetIds: a.targetIds, targetSeats: a.targetSeats };
      hovered = null; // hide the just-clicked card's detail so it can't cover targets
      if (activating.kind === "discard" && a.targets > 0) viewPile = "discard"; // pick the target from the discard viewer
      return;
    }
    if (view.awaiting && a.kind === "activate") dispatch("respond", { activate: { iid: a.iid, role: a.role, ...(a.as ? { as: a.as } : {}) } });
    else if (a.kind === "normalSummon") dispatch("command", { do: "summon", iid: a.iid });
    else if (a.kind === "discard") dispatch("command", { do: "discard", iid: a.iid });
    else if (a.kind === "activate" && a.handMeld) startMeld("hand", a.iid); // >dama: pick 3 hand cards
    else if (a.kind === "activate") dispatch("command", { do: "activate", iid: a.iid, role: a.role, ...(a.as ? { as: a.as } : {}) });
    else if (a.kind === "attack") { targeting = a.iid; hovered = null; } // enter target-selection mode
  }
  function chooseTarget(target: string) {
    if (!targeting) return;
    dispatch("command", { do: "attack", attacker: targeting, target });
    targeting = null;
  }
  function cancelActivate() { activating = null; viewPile = null; }
  let guessInput = ""; // a numeric-answer prompt (e.g. a VALUE guess)
  function submitGuess(min: number, max: number) {
    const n = Number(guessInput);
    if (!Number.isInteger(n) || n < min || n > max) return;
    dispatch("choose", { use: true, value: n });
    guessInput = "";
  }
  /** Send a completed activation as a chain response (open window) or a command.
   *  `as` = the granting cardId for a Twin-Personality-granted ability — the server
   *  validates the exact (iid, role, as) triple, so it must ride along.
   *  (Any "you can …" / "choose" decision is made later, at resolution.) */
  function finishActivate(iid: string, role: string, targets: string[], responding: boolean, as?: string) {
    const a = { iid, role, ...(targets.length ? { targets } : {}), ...(as ? { as } : {}) };
    if (responding) dispatch("respond", { activate: a });
    else dispatch("command", { do: "activate", ...a });
  }
  function sendActivate(targets: string[]) {
    if (!activating) return;
    finishActivate(activating.iid, activating.role, targets, !!activating.respond, activating.as);
    activating = null; viewPile = null;
  }
  // Are we currently picking a character target? Reactive so target highlights
  // re-render the instant we enter targeting (a `charTarget(c)` call alone would
  // hide the `activating` dependency from Svelte — see oppPicking note below).
  $: charPicking = !!activating && activating.kind === "character" && activating.picked.length < activating.need;
  // a valid character target while picking: the server-computed id set is the
  // truth when present (it may include FACE-DOWN targets, e.g. Useless Censors);
  // without one, default to face-up characters. (`picking` carries reactivity.)
  const charTarget = (c: CardView, picking: boolean, ids: string[] | undefined) =>
    picking && (ids ? ids.includes(c.iid) : !c.faceDown && c.cardId !== null);
  // Are we currently picking an opponent target? Reactive (references `activating`
  // directly) so the nameplate target buttons re-render the moment we enter
  // targeting mode — a function call like oppTarget(p) would hide that dependency.
  $: oppPicking = !!activating && (activating.kind === "opponent" || activating.kind === "player") && activating.picked.length < activating.need;
  // Public targeting markers (visible to ALL players): what a declared attack or a
  // chained effect is currently aimed at, so opponents can decide whether to respond.
  $: aimMarks = (() => {
    const m = new Map<string, string>();
    for (const iid of view.pending.targets) m.set(iid, "🎯"); // effect target
    for (const iid of view.pending.discards) m.set(iid, "💥"); // about to be battle-discarded
    for (const c of view.pending.meld?.cards ?? []) m.set(c.iid, "🧩"); // declared meld material
    if (view.pending.battle) { m.set(view.pending.battle.attacker, "⚔️"); m.set(view.pending.battle.target, "🎯"); }
    return m;
  })();
  // Matchmaker (My /mjg/ Crush): 💘 on both halves of each bonded pair (numbered when several)
  $: bondMarks = (() => {
    const m = new Map<string, { label: string; tip: string }>();
    (view.bonds ?? []).forEach((b, i) => {
      const num = (view.bonds ?? []).length > 1 ? String(i + 1) : "";
      m.set(b.a, { label: "💘" + num, tip: bondTip(b.b) });
      m.set(b.b, { label: "💘" + num, tip: bondTip(b.a) });
    });
    return m;
  })();
  const bondTip = (partner: string) => {
    const pc = view.players.flatMap((pl) => pl.board).find((c) => c.iid === partner);
    const nm = pc ? nameOf(pc) || pc.cardId || "a face-down card" : "its partner";
    return `bonded with ${nm} (My /mjg/ Crush): they cannot attack each other, and if one is discarded so is the other`;
  };
  function pickActTarget(iid: string) {
    if (!activating || activating.picked.includes(iid)) return; // no double-picking the same card
    const picked = [...activating.picked, iid];
    if (picked.length >= activating.need) sendActivate(picked);
    else activating = { ...activating, picked };
  }
  function global(a: LegalAction) {
    if (a.kind === "draw") dispatch("command", { do: "draw" });
    else if (a.kind === "endTurn") dispatch("command", { do: "endTurn" });
    else if (a.kind === "advance") dispatch("command", { do: "advance" });
    else if (a.kind === "meld") startMeld("board");
    else if (a.kind === "kan") { kanning = a; hovered = null; } // then pick the 4th card
  }
  const glabel: Record<string, string> = { draw: "Draw for turn", endTurn: "End turn", advance: "Next turn", meld: "Meld" };
  const gLabel = (a: LegalAction) => (a.kind === "kan" ? `KAN meld #${a.meldIndex + 1}` : glabel[a.kind] ?? a.kind);

  // ---- meld selection (link-summon style: pick 3, only valid extensions stay pickable) ----
  // a server-driven hand-meld pick (Belly Dance copying >dama): pick 3 hand cards.
  $: bellyMeld = !!view.choice?.handMeld;
  $: handMeldPick = handMelding || bellyMeld; // hand cards are meld-selectable
  // an effect makes ME pick a card from my own hand (discard / reveal / banish):
  // same UI as the hand-size discard — click a hand card and an action button
  // (the server-provided label) pops up on it. The standard for ALL such effects.
  $: handPick = view.choice?.handPick ?? null;
  $: handPickIds = handPick ? new Set((view.choice?.options ?? []).map((o) => o.iid)) : null;
  // multi-pick costs: cards already chosen this prompt (still in place) — outlined
  // so the player can see what they've selected so far.
  $: pickedSet = new Set(view.choice?.picked ?? []);
  // a choice whose options are all DECK cards (a search / top-N look): shown as a
  // pile-viewer popup with real card art instead of text buttons in the banner.
  $: deckPick = view.choice && !view.choice.reorder && !view.choice.handMeld && !view.choice.handPick && !view.choice.numberInput
    && view.choice.options.length > 0 && view.choice.options.every((o) => o.zone === "deck")
    ? view.choice : null;
  // choice options that are cards ON THE FIELD: picked by clicking the card directly
  // (highlighted like attack/effect targeting) — never via banner buttons. When ALL
  // options are field cards the banner buttons are dropped entirely.
  $: fieldChoice = view.choice && !view.choice.reorder && !view.choice.handMeld && !view.choice.numberInput && !deckPick
    ? new Set(view.choice.options.filter((o) => o.zone === "board").map((o) => o.iid))
    : new Set<string>();
  $: fieldChoiceOnly = fieldChoice.size > 0 && !!view.choice && view.choice.options.every((o) => o.zone === "board");
  const chooseCard = (iid: string) => dispatch("choose", { use: true, target: iid });
  // the synthetic per-card action button (Discard/Reveal/Banish) for a pickable hand card
  function handPickActions(iid: string): LegalAction[] {
    if (!handPick || !handPickIds?.has(iid)) return [];
    return [{ kind: handPick, iid } as unknown as LegalAction];
  }
  let prevBelly = false;
  $: { if (bellyMeld && !prevBelly) meldSel = []; prevBelly = bellyMeld; } // fresh selection on entry
  // meld sources: hand cards for a from-hand special meld; else own face-up board + discard top
  $: meldSources = !me
    ? []
    : meldMode === "hand" || bellyMeld
      ? (me.hand ?? [])
      : [...me.board.filter((c) => !c.faceDown && c.cardId !== null), ...(view.discard[0] ? [view.discard[0]] : [])];
  $: meldSelValues = meldSel.map((iid) => meldSources.find((c) => c.iid === iid)?.value ?? null);
  function confirmBellyMeld() {
    if (meldSel.length !== 3) return;
    dispatch("choose", { use: true, materials: [...meldSel] });
    meldSel = [];
  }
  function startMeld(mode: "board" | "hand", active: string | null = null) {
    targeting = null; meldSel = []; meldMode = mode; meldActive = active; melding = true; hovered = null;
  }
  function cancelMeld() { melding = false; meldActive = null; meldSel = []; meldChoices = null; }
  // resolved value of each selected material for a chosen value-tuple: fixed cards
  // keep their printed value, ☆ (null) materials take whatever values are left over.
  function perCardValues(sel: string[], candidate: number[]): number[] {
    const remaining = [...candidate];
    const out: number[] = new Array(sel.length);
    sel.forEach((iid, i) => {
      const v = meldSources.find((c) => c.iid === iid)?.value ?? null;
      if (v != null) { const k = remaining.indexOf(v); if (k >= 0) remaining.splice(k, 1); out[i] = v; }
    });
    sel.forEach((iid, i) => {
      const v = meldSources.find((c) => c.iid === iid)?.value ?? null;
      if (v == null) out[i] = remaining.shift()!;
    });
    return out;
  }
  function sendMeld(candidate?: number[]) {
    const values = candidate ? perCardValues(meldSel, candidate) : undefined;
    dispatch("command", { do: "meld", materials: [...meldSel], ...(values ? { values } : {}), ...(meldMode === "hand" && meldActive ? { source: meldActive } : {}) });
    cancelMeld();
  }
  function confirmMeld() {
    if (meldSel.length !== 3) return;
    // a ☆ material whose value isn't forced must be pinned by the player first
    if (meldSelValues.some((v) => v == null)) {
      const cands = meldAssignments(meldSelValues);
      if (cands.length > 1) { meldChoices = cands; return; }
      sendMeld(cands[0]); // exactly one option -> auto-pin
      return;
    }
    sendMeld();
  }
  function toggleMeld(iid: string) {
    const c = meldSources.find((x) => x.iid === iid);
    if (!c) return; // not a meld source (e.g. a hand card) -> ignore
    if (meldSel.includes(iid)) meldSel = meldSel.filter((x) => x !== iid);
    else if (meldSel.length < 3 && canExtendMeld(meldSelValues, c.value ?? null)) meldSel = [...meldSel, iid];
  }
  const TOGGLES: ChainToggle[] = ["off", "auto", "always"];
  const toggleLabel: Record<ChainToggle, string> = { off: "off", auto: "auto", always: "on" };
</script>

<div class="table">
  <!-- center: shared wall, with controls below -->
  <div class="center" style="grid-area:center">
    <div class="piles">
      {#if view.extraZone.length}
        <div class="pile">
          <div class="extrarow">
            {#each view.extraZone as ez (ez.iid)}
              <CardSlot card={ez} name={nameOf(ez)} front={frontOf(ez)}
                selected={selected === ez.iid && !targeting}
                actions={freeMode || busy ? [] : actionsFor(ez.iid)}
                on:select={(e) => (freeMode ? openFree(e.detail) : busy ? undefined : select(e.detail))}
                on:act={(e) => act(e.detail)}
                on:mouseenter={() => (hovered = ez)} on:mouseleave={() => (hovered = null)} />
            {/each}
          </div>
          <span>Extra {view.extraZone.length}</span>
        </div>
      {/if}
      {#if view.deckTop}
        <!-- Right-to-Left: the deck is upside-down, its top card is face-out -->
        <div class="pile">
          <Card card={view.deckTop} name={nameOf(view.deckTop)} front={frontOf(view.deckTop)}
            on:mouseenter={() => (hovered = view.deckTop)} on:mouseleave={() => (hovered = null)} />
          <span>Main {view.mainDeckCount} {view.deckFlipped ? "🙃" : "👁"}</span>
        </div>
      {:else}
        <div class="pile"><div class="stack back-main"></div><span>Main {view.mainDeckCount}</span></div>
      {/if}
      {#if view.faithTop}
        <!-- Doxxed: the Faith deck's top card is public -->
        <div class="pile">
          <Card card={view.faithTop} name={nameOf(view.faithTop)} front={frontOf(view.faithTop)}
            on:mouseenter={() => (hovered = view.faithTop)} on:mouseleave={() => (hovered = null)} />
          <span>Faith {view.faithDeckCount} 👁</span>
        </div>
      {:else}
        <div class="pile"><div class="stack back-faith"></div><span>Faith {view.faithDeckCount}</span></div>
      {/if}
      <div class="pile">
        {#if view.discard[0]}
          {@const d = view.discard[0]}
          {@const dpicked = meldSel.includes(d.iid)}
          {@const dmable = boardMelding && !dpicked && meldSel.length < 3 && canExtendMeld(meldSelValues, d.value ?? null)}
          {@const dknb = kanIds.has(d.iid)}
          <span class="mwrap" class:meldable={dmable || dknb} class:dim={boardMelding && !dpicked && !dmable}>
            <Card card={d} name={nameOf(d)} front={frontOf(d)} clickable selected={dpicked || freeSel.includes(d.iid)}
              on:click={() => (freeMode ? openFree(d.iid) : dknb ? pickKan(d.iid) : boardMelding ? toggleMeld(d.iid) : (viewPile = "discard"))}
              on:mouseenter={() => (hovered = d)} on:mouseleave={() => (hovered = null)} />
          </span>
        {:else}<div class="stack empty-pile"></div>{/if}
        <span>Discard {view.discard.length}{#if view.discard.length}<span class="seehint"> · view</span>{/if}</span>
      </div>
      <div class="pile">
        {#if view.banish[0]}
          {@const bz = view.banish[0]}
          <Card card={bz} name={nameOf(bz)} front={frontOf(bz)} clickable selected={freeSel.includes(bz.iid)}
            on:click={() => (freeMode ? openFree(bz.iid) : (viewPile = "banish"))}
            on:mouseenter={() => (hovered = bz)} on:mouseleave={() => (hovered = null)} />
        {:else}<div class="stack banish"></div>{/if}
        <span>Banish {view.banish.length}{#if view.banish.length}<span class="seehint"> · view</span>{/if}</span>
      </div>
    </div>

    <div class="control">
      <div class="phase">
        <b>{view.phase}</b> · active <b>P{view.activePlayer}</b>
        {#if view.winner !== null}· 🏆 <b>P{view.winner}</b>{/if}
      </div>
      {#if view.pending.meld}
        {@const pm = view.pending.meld}
        <!-- a declared meld is public: its materials are revealed while in its window -->
        <div class="chainpanel">
          <span class="chainlbl">🧩 P{pm.player} melding</span>
          {#each pm.cards as c}
            <button class="chainchip" on:mouseenter={() => (hovered = c)} on:mouseleave={() => (hovered = null)}>
              {CARD.get(c.cardId ?? "") ?? c.cardId ?? "?"}
            </button>
          {/each}
        </div>
      {/if}
      {#if view.stack.length}
        <!-- the chain is public: activated cards are revealed to everyone -->
        <div class="chainpanel">
          <span class="chainlbl">⛓ chain</span>
          {#each view.stack as e, i}
            <button class="chainchip" on:mouseenter={() => (hovered = e.card)} on:mouseleave={() => (hovered = null)}>
              {i + 1}. P{e.controller} · {CARD.get(e.card.cardId ?? "") ?? e.card.cardId ?? "?"}
            </button>
          {/each}
        </div>
      {/if}
      {#if targeting}
        <div class="banner targeting"><b>Choose a target</b> — <button class="pass" on:click={() => (targeting = null)}>Cancel</button></div>
      {/if}
      {#if kanning}
        <div class="banner melding"><b>KAN</b> — click the matching 4th card (highlighted) <button class="pass" on:click={() => (kanning = null)}>Cancel</button></div>
      {/if}
      {#if view.phase === "FORCED_DISCARD"}
        {#if view.legal.some((a) => a.kind === "discard")}
          <div class="banner targeting"><b>Discard a card</b> — click one of your cards (one at a time)</div>
        {:else}
          <div class="banner respond">waiting for a player to discard…</div>
        {/if}
      {/if}
      {#if activating && activating.picked.length < activating.need}
        <div class="banner targeting"><b>Choose {activating.need - activating.picked.length} {activating.kind === "discard" ? "discarded card" : activating.kind === "opponent" ? "opponent (click a nameplate)" : "character"}</b> — <button class="pass" on:click={cancelActivate}>Cancel</button></div>
      {/if}
      {#if melding}
        <div class="banner melding">
          {#if meldChoices}
            <b>Specify the ☆ value</b> —
            {#each meldChoices as cand}
              <button class="hot" on:click={() => sendMeld(cand)}>
                {cand[0] === cand[1] && cand[1] === cand[2] ? "Triplet" : "Sequence"} {cand.join("-")}
              </button>
            {/each}
            <button class="pass" on:click={() => (meldChoices = null)}>Back</button>
          {:else}
            <b>{handMelding ? "Special meld (hand)" : "Meld"}</b> — pick 3 ({meldSel.length}/3)
            <button class="hot" disabled={meldSel.length !== 3} on:click={confirmMeld}>Confirm</button>
            <button class="pass" on:click={cancelMeld}>Cancel</button>
          {/if}
        </div>
      {/if}
      {#if bellyMeld}
        <div class="banner melding">
          <b>{view.choice?.prompt ?? "Special meld"}</b> — pick 3 from hand ({meldSel.length}/3)
          <button class="hot" disabled={meldSel.length !== 3} on:click={confirmBellyMeld}>Confirm</button>
        </div>
      {/if}
      {#if view.awaiting && !busy}
        <div class="banner respond"><b>Respond?</b> click a card's effect, or <button class="pass" on:click={() => dispatch("respond", { pass: true })}>Pass</button></div>
      {/if}
      {#if handPick}
        <div class="banner targeting"><b>{view.choice?.prompt ?? "Pick a card"}</b> — click {fieldChoice.size ? "a highlighted card" : "a card in your hand"}</div>
      {/if}
      {#if view.choice?.placeCard}
        <div class="banner targeting"><b>{view.choice.prompt ?? "Explosive Aria"}</b></div>
      {/if}
      {#if view.choice && !view.choice.reorder && !view.choice.handMeld && !view.choice.handPick && !deckPick && !view.choice.placeCard && view.choice.revealOwner === undefined}
        {@const ch = view.choice}
        <div class="banner choice">
          <b>{ch.prompt ?? effectLabel(ch.effectId)}</b>
          {#if ch.preview}
            {@const pv = ch.preview}
            <button class="cardlink" class:on={scryPreview?.cardId === pv.cardId}
              on:click={() => (scryPreview = scryPreview ? null : { iid: pv.iid, cardId: pv.cardId })}
              >{CARD.get(pv.cardId ?? "") ?? pv.cardId}</button>
          {/if}
          —
          {#if ch.numberInput}
            {@const ni = ch.numberInput}
            <input class="guess" type="number" min={ni.min} max={ni.max} placeholder="{ni.min}-{ni.max}"
              bind:value={guessInput} on:keydown={(e) => e.key === "Enter" && submitGuess(ni.min, ni.max)} />
            <button class="hot" on:click={() => submitGuess(ni.min, ni.max)}>Submit</button>
          {:else if fieldChoiceOnly}
            click a highlighted card
          {:else if ch.options.length}
            choose:
            {#each ch.options.filter((o) => !fieldChoice.has(o.iid)) as o}
              <button class="hot" on:click={() => dispatch("choose", { use: true, target: o.iid })}>{o.label ?? `${CARD.get(o.cardId ?? "") ?? o.cardId} (${o.zone})`}</button>
            {/each}
            {#if fieldChoice.size}<span class="orclick">… or click a highlighted card</span>{/if}
          {:else}
            <button class="hot" on:click={() => dispatch("choose", { use: true })}>{ch.prompt ? "Yes" : "Use"}</button>
          {/if}
          {#if !ch.mandatory && !ch.numberInput}<button class="pass" on:click={() => dispatch("choose", { use: false })}>{ch.prompt ? "No" : "Skip"}</button>{/if}
        </div>
      {/if}
      <div class="buttons">
        {#each globalActions as a}<button class="hot" disabled={busy} on:click={() => global(a)}>{gLabel(a)}</button>{/each}
      </div>
      <!-- chain toggle + log sit ABOVE the interaction layer: clickable even while
           prompted/targeting (changing your priority preference isn't a game action). -->
      <div class="toggle">
        chain:
        {#each TOGGLES as t}
          <button class:on={view.toggle === t} on:click={() => dispatch("setToggle", t)}>{toggleLabel[t]}</button>
        {/each}
        <button class="logbtn" on:click={() => (viewLog = true)}>Log</button>
      </div>
    </div>
  </div>

  <!-- opponents, placed & rotated by mahjong slot -->
  {#each opponents as p (p.pid)}
    {@const slot = slotFor(p.pid)}
    {@const side = slot === "left" || slot === "right"}
    {@const pc = p.boardPages ?? 1}
    {@const pg = Math.min(boardPage[p.pid] ?? 0, pc - 1)}
    {@const shown = placed(p.board, pg)}
    <div class="oppseat {slot}" style="grid-area:{slot}" class:active={p.pid === view.activePlayer} class:dead={p.eliminated}>
      <div class="nameplate np-{slot}">
        <b>{pname(p.pid)} (P{p.pid})</b>
        {#if p.pid === view.activePlayer}<span class="tag turn">turn</span>{/if}
        {#if view.prioritySeat === p.pid}<span class="tag pri">priority</span>{/if}
        {#if p.eliminated}<span class="tag">out</span>{/if}
        <span class="tag">✋ {p.handCount}</span>
        {#each Object.entries(p.counters ?? {}).filter(([k, n]) => n > 0 && k !== "poison") as [k, n] (k)}
          <span class="tag ctrtag" title="{k} counter{n > 1 ? 's' : ''}">{PCTR[k] ?? "◈"} {k} ×{n}</span>
        {/each}
        {#if p.poison}<span class="tag poisontag" class:armed={p.poison === "armed"}
          title={p.poison === "active" ? "poisoned: each card played discards 1 random hand card per ☠" : "poisoned starting their next turn"}>☠ ×{p.counters?.["poison"] ?? 0}{p.poison === "armed" ? " next turn" : ""}</span>{/if}
        <button class="tag meldbtn" title="view melds" on:click={() => (viewMelds = p.pid)}>▦ {p.meldZone.length}/4</button>
        {#if oppPicking && p.pid !== view.viewer && !p.eliminated && (!activating?.targetSeats || activating.targetSeats.includes(p.pid))}<button class="tag tgtbtn" on:click={() => pickActTarget(String(p.pid))}>🎯 target</button>{/if}
        {#if view.pending.targetSeats.includes(p.pid)}<span class="tag aimtag">🎯 targeted</span>{/if}
      </div>
      <!-- board flows along the seat's own axis (cards rotate to face that player);
           lines stack on the perpendicular axis (2 rows / 2 columns for 6–8 cards) -->
      <div class="oppboard {slot}">
        <div class="freeb opp" class:side data-seat={p.pid} data-slot={slot}>
          {#each shown as pcd, zi (pcd.c.iid)}
            {@const c = pcd.c}
            {@const tgt = !!targeting && !c.faceDown && c.cardId !== null && !c.unattackable}
            {@const atg = charTarget(c, charPicking, activating?.targetIds)}
            {@const bpk = fieldChoice.has(c.iid)}
            <span class="cw {slot} fpos" class:targetable={tgt || atg || bpk} class:aimed={aimMarks.has(c.iid)}
              style="{slot === 'right' ? 'right' : 'left'}: calc(var(--cw, 92px) * {(side ? pcd.y : pcd.x) / 100}); top: calc(var(--cw, 92px) * {(side ? pcd.x : pcd.y) / 100}); z-index: {zi + 1};">
              {#if aimMarks.has(c.iid)}<span class="aimbadge">{aimMarks.get(c.iid)}</span>{/if}
              {#if bondMarks.has(c.iid)}<span class="bondbadge" title={bondMarks.get(c.iid)?.tip}>{bondMarks.get(c.iid)?.label}</span>{/if}
              <Card card={c} name={nameOf(c)} front={frontOf(c)} big={isBig(c)} clickable={freeMode || tgt || atg || bpk}
                selected={freeSel.includes(c.iid)}
                on:click={() => (freeMode ? openFree(c.iid) : tgt ? chooseTarget(c.iid) : atg ? pickActTarget(c.iid) : bpk ? chooseCard(c.iid) : undefined)}
                on:overlays={(e) => (viewOverlaid = e.detail)}
                on:mouseenter={() => (hovered = c)} on:mouseleave={() => (hovered = null)} />
            </span>
          {/each}
          {#if !shown.length}<span class="empty">no board</span>{/if}
        </div>
        {#if pc > 1}
          <span class="pager">
            <button on:click={() => setPage(p.pid, pg - 1)} disabled={pg === 0}>‹</button>
            <span class="pgn">{pg + 1}/{pc}</span>
            <button on:click={() => setPage(p.pid, pg + 1)} disabled={pg === pc - 1}>›</button>
          </span>
        {/if}
      </div>
    </div>
  {/each}

  <!-- you (bottom) -->
  {#if me}
    {@const m = me}
    {@const mpc = m.boardPages ?? 1}
    {@const mpg = Math.min(boardPage[m.pid] ?? 0, mpc - 1)}
    {@const mshown = placed(m.board, mpg)}
    {@const hand = m.hand ?? []}
    {@const hpc = Math.max(1, Math.ceil(hand.length / HAND_PAGE))}
    {@const hpg = Math.min(handPage, hpc - 1)}
    {@const hshown = hand.slice(hpg * HAND_PAGE, hpg * HAND_PAGE + HAND_PAGE)}
    <div class="seat self" style="grid-area:self" class:active={view.activePlayer === m.pid}>
      <div class="selfboard">
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div class="freeb self" bind:this={boardEl} class:arrangeable={view.arrange && !freeMode} data-seat={m.pid}>
          <span class="cwprobe" bind:this={probeEl}></span>
          {#each mshown as pcd, zi (pcd.c.iid)}
            {@const c = pcd.c}
            {@const picked = meldSel.includes(c.iid)}
            {@const mable = boardMelding && !picked && meldSel.length < 3 && canExtendMeld(meldSelValues, c.value ?? null)}
            {@const atg = charTarget(c, charPicking, activating?.targetIds)}
            {@const bpk = fieldChoice.has(c.iid)}
            {@const knb = kanIds.has(c.iid)}
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <span class="mwrap fpos" class:meldable={mable || knb} class:targetable={atg || bpk} class:aimed={aimMarks.has(c.iid)} class:dim={melding && !mable && !(boardMelding && picked)} class:carrying={carry !== null && carry.iid === c.iid}
              style="left: calc(var(--cw, 92px) * {(carry && carry.iid === c.iid ? carry.px : pcd.x) / 100}); top: calc(var(--cw, 92px) * {(carry && carry.iid === c.iid ? carry.py : pcd.y) / 100}); z-index: {carry && carry.iid === c.iid ? 40 : zi + 1};">
              {#if aimMarks.has(c.iid)}<span class="aimbadge">{aimMarks.get(c.iid)}</span>{/if}
              {#if bondMarks.has(c.iid)}<span class="bondbadge" title={bondMarks.get(c.iid)?.tip}>{bondMarks.get(c.iid)?.label}</span>{/if}
              <CardSlot card={c} name={nameOf(c)} front={frontOf(c)} big={isBig(c)}
                selected={freeSel.includes(c.iid) || pickedSet.has(c.iid) || (!activating && (boardMelding ? picked : selected === c.iid && !targeting))}
                actions={freeMode || busy ? [] : actionsFor(c.iid)}
                movable={view.arrange && !freeMode && !busy} on:move={(e) => startCarry(e.detail)}
                on:select={(e) => (freeMode ? openFree(e.detail) : knb ? pickKan(e.detail) : bpk ? chooseCard(e.detail) : activating ? pickActTarget(e.detail) : boardMelding ? toggleMeld(e.detail) : busy ? undefined : select(e.detail))}
                on:act={(e) => act(e.detail)}
                on:overlays={(e) => (viewOverlaid = e.detail)}
                on:mouseenter={() => (hovered = c)} on:mouseleave={() => (hovered = null)} />
            </span>
          {/each}
          {#if !mshown.length}<span class="empty">your board is empty</span>{/if}
        </div>
        <div class="boardfoot">
          <span class="pager">
            <button on:click={() => setPage(m.pid, mpg - 1, true)} disabled={mpg === 0}>‹</button>
            <span class="pgn">{mpg + 1}/{mpc}</span>
            <button on:click={() => setPage(m.pid, mpg + 1, true)} disabled={mpg === mpc - 1}>›</button>
            <button class="addpg" disabled={!canAddPage} title={canAddPage ? "add a board page" : "every page needs at least 4 cards before adding another"} on:click={() => dispatch("board", { do: "addPage" })}>+</button>
          </span>
          {#if m.meldZone.length}<span class="meldtag">▦ {m.meldZone.map((x) => `${x.kind}${x.kan ? "+K" : ""}`).join(", ")}</span>{/if}
        </div>
      </div>
      <div class="nameplate self-plate">
        <b>{pname(m.pid)} (P{m.pid})</b>
        {#if view.activePlayer === m.pid}<span class="tag turn">your turn</span>{/if}
        {#if view.prioritySeat === m.pid}<span class="tag pri">priority</span>{/if}
        <button class="tag meldbtn" title="view melds" on:click={() => (viewMelds = m.pid)}>▦ {m.meldZone.length}/4</button>
        {#each Object.entries(m.counters ?? {}).filter(([k, n]) => n > 0 && k !== "poison") as [k, n] (k)}
          <span class="tag ctrtag" title="{k} counter{n > 1 ? 's' : ''}">{PCTR[k] ?? "◈"} {k} ×{n}</span>
        {/each}
        {#if m.poison}<span class="tag poisontag" class:armed={m.poison === "armed"}
          title={m.poison === "active" ? "poisoned: each card played discards 1 random hand card per ☠" : "poisoned starting their next turn"}>☠ ×{m.counters?.["poison"] ?? 0}{m.poison === "armed" ? " next turn" : ""}</span>{/if}
        {#if oppPicking && activating?.kind === "player" && (!activating?.targetSeats || activating.targetSeats.includes(m.pid))}<button class="tag tgtbtn" on:click={() => pickActTarget(String(m.pid))}>🎯 target</button>{/if}
        {#if view.pending.targetSeats.includes(m.pid)}<span class="tag aimtag">🎯 targeted</span>{/if}
      </div>
      <div class="row hand" class:dim={boardMelding}>
        {#each hshown as c (c.iid)}
          {@const picked = meldSel.includes(c.iid)}
          {@const mable = handMeldPick && !picked && meldSel.length < 3 && canExtendMeld(meldSelValues, c.value ?? null)}
          {@const knb = kanIds.has(c.iid)}
          <span class="mwrap" class:meldable={mable || knb} class:dim={handMeldPick && !picked && !mable}>
            <CardSlot card={c} name={nameOf(c)} front={frontOf(c)}
              selected={freeSel.includes(c.iid) || pickedSet.has(c.iid) || (handMeldPick ? picked : selected === c.iid && !targeting)}
              actions={freeMode ? [] : handPick ? handPickActions(c.iid) : busy ? [] : actionsFor(c.iid)}
              on:select={(e) => (freeMode ? openFree(e.detail) : knb ? pickKan(e.detail) : handPick ? select(e.detail) : handMeldPick ? toggleMeld(e.detail) : busy ? undefined : select(e.detail))}
              on:act={(e) => act(e.detail)}
              on:mouseenter={() => (hovered = c)} on:mouseleave={() => (hovered = null)} />
          </span>
        {:else}<span class="empty">empty hand</span>{/each}
        {#if hpc > 1}
          <span class="pager">
            <button on:click={() => flipHand(-1, hand.length)} disabled={hpg === 0}>‹</button>
            <span class="pgn">{hpg + 1}/{hpc}</span>
            <button on:click={() => flipHand(1, hand.length)} disabled={hpg === hpc - 1}>›</button>
          </span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<CardDetail card={detailCard} />
{#if view.cheats}
  <DevPanel on:spawn={(e) => dispatch("devSpawn", e.detail)} />
  <!-- Free mode: dev sandbox — click any visible card for direct zone actions -->
  <button class="freetab" class:on={freeMode} on:click={toggleFree} title="free mode: move any visible card between zones, unlimited summons/melds">
    🕹 Free mode {freeMode ? "ON" : "off"}
  </button>
{/if}
{#if view.cheats && freeMode}
  <div class="freebar">
    <span class="mp">deck:</span>
    <button on:click={() => freeAct({ do: "draw", deck: "main" })}>Draw Main</button>
    <button on:click={() => freeAct({ do: "draw", deck: "faith" })}>Draw Faith</button>
    <button on:click={() => freeAct({ do: "search", deck: "main" })}>Search Main</button>
    <button on:click={() => freeAct({ do: "search", deck: "faith" })}>Search Faith</button>
    {#if freeMenu}
      {@const fid = freeMenu}
      {@const fcv = [...view.players.flatMap((p) => [...p.board, ...(p.hand ?? [])]), ...view.discard, ...view.banish].find((c) => c.iid === fid)}
      <b>{fcv ? nameOf(fcv) || fcv.cardId || fid : fid}</b>
      <button on:click={() => freeAct({ do: "summon", iid: fid })}>Summon</button>
      <button on:click={() => freeAct({ do: "discard", iid: fid })}>Discard</button>
      <button on:click={() => freeAct({ do: "banish", iid: fid })}>Banish</button>
      <button on:click={() => freeAct({ do: "hand", iid: fid })}>To hand</button>
      <button on:click={() => freeAct({ do: "deck", iid: fid })}>To deck + shuffle</button>
      <button on:click={() => freeMeldPick(fid)}>{freeSel.includes(fid) ? "− Meld pick" : "+ Meld pick"}</button>
      <button class="x" on:click={() => (freeMenu = null)}>✕</button>
    {/if}
    {#if freeSel.length}
      <span class="mp">meld picks: {freeSel.length}/3</span>
      <button disabled={freeSel.length !== 3} on:click={freeMeldConfirm}>Meld 3</button>
      <button on:click={() => (freeSel = [])}>Clear</button>
    {/if}
  </div>
{/if}

{#if viewPile === "discard"}
  <PileViewer title="Discard pile" cards={[...view.discard]}
    pick={(!!activating && activating.kind === "discard") || freeMode} picked={activating?.picked ?? freeSel} actions={discardActs}
    on:close={() => (activating && activating.kind === "discard" ? cancelActivate() : (viewPile = null))}
    on:pick={(e) => (activating ? pickActTarget(e.detail) : (viewPile = null, openFree(e.detail)))}
    on:act={(e) => { viewPile = null; act(e.detail); }}
    on:hover={(e) => (hovered = e.detail)} />
{/if}

{#if viewPile === "banish"}
  <PileViewer title="Banish pile" cards={[...view.banish]} pick={freeMode} picked={freeSel}
    on:close={() => (viewPile = null)}
    on:pick={(e) => { viewPile = null; openFree(e.detail); }}
    on:hover={(e) => (hovered = e.detail)} />
{/if}

{#if view.choice?.revealOwner !== undefined}
  {@const ro = view.choice.revealOwner}
  {@const shown = view.revealedHands.find((r) => r.owner === ro)}
  <!-- Collusion: the shown hand IS the decision screen — accept (reveal back) or reject.
       An ack-only prompt (the activator confirming, pre-draw) shows a single button. -->
  <PileViewer title="Player {ro}'s hand (shown to you)" cards={shown?.cards ?? []} closable={false}
    choice={view.choice.ack ? { yes: view.choice.prompt ?? "OK" } : { yes: view.choice.prompt ?? "Show your hand back?", no: "Reject" }}
    on:yes={() => dispatch("choose", { use: true })}
    on:no={() => dispatch("choose", { use: false })}
    on:hover={(e) => (hovered = e.detail)} />
{/if}

{#if deckPick}
  {@const dp = deckPick}
  <!-- a deck search/look: pick the card from a viewer (real art), not text buttons.
       Mandatory picks can't be dismissed; optional ones close = decline. -->
  <PileViewer title={dp.prompt ?? effectLabel(dp.effectId)}
    cards={dp.options.map((o) => ({ iid: o.iid, cardId: o.cardId }))}
    pick closable={!dp.mandatory}
    on:pick={(e) => dispatch("choose", { use: true, target: e.detail })}
    on:close={() => dispatch("choose", { use: false })}
    on:hover={(e) => (hovered = e.detail)} />
{/if}

{#if ariaPlace}
  {@const ac = { iid: ariaPlace.iid, cardId: ariaPlace.cardId }}
  <div class="ariaghost" style="left: {ariaXY.x}px; top: {ariaXY.y}px;">
    <Card card={ac} name={nameOf(ac)} front={frontOf(ac)} />
  </div>
{/if}

{#if viewOverlaid}
  <PileViewer title="Overlaid under {nameOf(viewOverlaid)}" cards={viewOverlaid.overlaid ?? []}
    on:close={() => (viewOverlaid = null)} on:hover={(e) => (hovered = e.detail)} />
{/if}

{#if viewMelds !== null}
  {@const mp = view.players.find((p) => p.pid === viewMelds)}
  {#if mp}
    <MeldViewer title={mp.pid === view.viewer ? "Your melds" : `Player ${mp.pid} — melds`}
      melds={mp.meldZone} on:close={() => (viewMelds = null)} on:hover={(e) => (hovered = e.detail)} />
  {/if}
{/if}

{#if viewLog}
  <LogViewer lines={view.log} on:close={() => (viewLog = false)} />
{/if}

{#if view.choice?.reorder}
  {@const rc = view.choice}
  <ReorderViewer title={rc.prompt ?? effectLabel(rc.effectId)}
    cards={rc.options.map((o) => ({ iid: o.iid, cardId: o.cardId }))}
    on:hover={(e) => (hovered = e.detail)}
    on:done={(e) => dispatch("choose", { use: true, order: e.detail })} />
{/if}

<style>
  .table {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    grid-template-rows: auto minmax(170px, 1fr) auto;
    grid-template-areas:
      "left   top     right"
      "left   center  right"
      "self   self    self";
    gap: 10px; padding: 10px; height: calc(100dvh - 44px); box-sizing: border-box; overflow: hidden;
    align-items: center; justify-items: center;
    /* card width scales with the viewport (bounded) so the layout never gets cut off */
    --cw: clamp(50px, 6vw, 92px);
    --side-gap: clamp(24px, 8vw, 240px); /* space between centre and the left/right players (~a board) */
  }

  /* seats */
  .oppseat, .seat { border: 1px solid #2b313b; border-radius: 10px; padding: 8px; background: #161a22; }
  /* nameplate sits on the centre-facing side ("below" the board) and the seat is
     anchored to that edge of its cell, so the board grows outward without
     shifting the nameplate */
  .oppseat { display: flex; align-items: center; gap: 6px; }
  .oppseat.top { flex-direction: column-reverse; }          /* board on top, name below */
  /* side seats are pushed away from the centre by ~a board's worth (--side-gap) */
  /* align-self start: the side seats' tops sit on the same grid line as the
     across seat, so the boards' top edges level up; the strip grows downward */
  .oppseat.left { flex-direction: row-reverse; justify-self: end; align-self: start; margin-right: var(--side-gap); }   /* board outer (left), name inner (right) */
  .oppseat.right { flex-direction: row; justify-self: start; align-self: start; margin-left: var(--side-gap); }          /* name inner (left), board outer (right) */
  .oppseat.active { border-color: #6ea8ff; box-shadow: 0 0 0 1px #6ea8ff33 inset; }
  .oppseat.dead { opacity: 0.45; }
  /* your area: board and hand are separate, each sized to its own cards */
  .seat.self { border: none; background: none; padding: 0; justify-self: stretch;
    display: flex; flex-direction: column; align-items: center; gap: 6px; }

  /* opponent board: cards run along the seat axis; the 2 lines (for 6–8 cards)
     stack on the perpendicular axis */
  .oppboard { display: flex; gap: 12px; align-items: center; justify-content: center; }
  .oppboard.top { flex-direction: column; }            /* lines = stacked rows */
  .oppboard.left, .oppboard.right { flex-direction: row; } /* lines = side-by-side columns */
  /* the page-flip buttons rotate with their seat, like the nameplates */
  .oppboard.left .pager { writing-mode: vertical-rl; }
  .oppboard.right .pager { writing-mode: vertical-rl; transform: rotate(180deg); }
  .cw { position: relative; display: grid; place-items: center; border-radius: 8px; }
  /* free-position board areas: a FIXED-size playmat (logical 770×250, scaled by
     --cw) — placing low never grows the board, the card just covers up space */
  .freeb { position: relative; width: calc(var(--cw, 92px) * 7.7); height: calc(var(--cw, 92px) * 1.45); max-width: 100%; user-select: none; }
  .freeb.side { width: calc(var(--cw, 92px) * 1.45); height: calc(var(--cw, 92px) * 7.7); }
  .freeb :global(img) { -webkit-user-drag: none; }
  .freeb.opp { margin: 0 auto; }
  .fpos.carrying { pointer-events: none; }
  .freeb.self { border: 1px dashed #2a3240; border-radius: 10px; }
  .freeb.self.arrangeable { border-color: #3d5a41; }
  /* .freeb prefix out-specifies .mwrap's later `position: relative` — without it
     self-board cards stay in flex flow and the left/top offsets ADD to flow slots */
  .freeb .fpos { position: absolute; }
  .freeb :global(.card.tapped) { margin: 0; } /* flex-era anti-overlap margins skew free positions */
  .cwprobe { position: absolute; width: var(--cw, 92px); height: 0; visibility: hidden; pointer-events: none; }
  .ariaghost { position: fixed; z-index: 95; transform: translate(-50%, -50%); pointer-events: none; filter: drop-shadow(0 0 10px #f66); }
  .freeb .empty { position: absolute; inset: 0; display: grid; place-items: center; }
  .addpg { font-weight: 700; }
  .cw.top { transform: rotate(180deg); }
  .cw.left, .cw.right { width: calc(var(--cw, 92px) * 1.391); height: var(--cw, 92px); } /* rotated footprint */
  .cw.left :global(.card) { transform: rotate(90deg); }
  .cw.right :global(.card) { transform: rotate(-90deg); }
  .cw.targetable { box-shadow: 0 0 0 2px #f96, 0 0 12px #f96a; cursor: crosshair; }
  /* public "this is being targeted/attacked" marker, visible to every player */
  .aimed { box-shadow: 0 0 0 2px #ff4d4d, 0 0 14px #ff4d4daa; border-radius: 8px; }
  .aimbadge {
    position: absolute; top: -8px; right: -8px; z-index: 5; pointer-events: none;
    font-size: 15px; line-height: 1; padding: 2px; border-radius: 50%;
    background: #1a1f29cc; box-shadow: 0 0 0 1px #ff4d4d;
  }
  /* counter-rotate the badge so it stays upright on rotated opponent seats */
  .cw.top .aimbadge { transform: rotate(180deg); }
  .cw.left .aimbadge { transform: rotate(-90deg); }
  .cw.right .aimbadge { transform: rotate(90deg); }
  /* Matchmaker bond: 💘 pinned mid-left on both halves of the pair */
  .bondbadge {
    position: absolute; top: 16px; left: -8px; z-index: 5; cursor: help;
    font-size: 13px; line-height: 1; padding: 2px 3px; border-radius: 9px;
    color: #ffd9ec; font-weight: 700;
    background: #1a1f29cc; box-shadow: 0 0 0 1px #ff7ab8;
  }
  .cw.top .bondbadge { transform: rotate(180deg); }
  .cw.left .bondbadge { transform: rotate(-90deg); }
  .cw.right .bondbadge { transform: rotate(90deg); }
  .tag.aimtag { color: #1a1f29; background: #ff4d4d; }
  .chainpanel { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; justify-content: center; max-width: 320px; }
  .chainlbl { font-size: 11px; color: #8b95a3; }
  .chainchip { font: inherit; font-size: 11px; color: #cdd4de; background: #2a2030; border: 1px solid #6e5aff; border-radius: 10px; padding: 1px 7px; cursor: help; }
  .chainchip:hover { background: #38304a; }

  .nameplate { display: flex; align-items: center; gap: 8px; color: #cdd4de; flex-wrap: wrap; justify-content: center; }
  /* side opponents: nameplate rotated to match their cards (across stays upright) */
  .nameplate.np-left { writing-mode: vertical-rl; flex-wrap: nowrap; }
  .nameplate.np-right { writing-mode: vertical-rl; transform: rotate(180deg); flex-wrap: nowrap; }
  .self-plate { margin: 12px 0 6px; justify-content: flex-start; }
  .tag { font-size: 11px; color: #8b95a3; background: #20252f; border-radius: 10px; padding: 1px 7px; }
  .tag.ctrtag { background: #2a2338; color: #d9c8f5; }
  .tag.poisontag { background: #16271d; color: #9fe8b0; }
  .tag.poisontag.armed { background: #33290f; color: #ffe08a; }
  .tag.meldbtn { cursor: pointer; font: inherit; font-size: 11px; border: 1px solid transparent; }
  .tag.meldbtn:hover { background: #2c313c; color: #cdd4de; border-color: #6ea8ff; }
  .tag.tgtbtn { cursor: pointer; font: inherit; font-size: 11px; color: #1a1f29; background: #6ea8ff; border: none; }
  .tag.tgtbtn:hover { background: #93c0ff; }
  .tag.turn { color: #bfe3ff; background: #1e3148; }
  .tag.pri { color: #cffbe0; background: #1e3a2a; }
  /* FIELD_PAGE/HAND_PAGE cap how many cards appear; the row wraps to more lines
     if that page is still wider than the screen, so cards are never cut off. */
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: center; max-width: 100%; }
  .row.hand { background: #11151c; border: 1px dashed #2b313b; border-radius: 10px; padding: 14px 10px; }
  /* your board: lines stack vertically; pager/meld summary in a footer below */
  .selfboard { display: flex; flex-direction: column; gap: 10px; align-items: center; }
  .boardfoot { display: flex; gap: 10px; align-items: center; justify-content: center; color: #5b6270; font-size: 11px; }
  /* slim placeholder so an empty board doesn't reserve a tall box / push the hand */
  .pager { display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; color: #8b95a3; font-size: 12px; }
  .pager button { padding: 2px 9px; border-radius: 6px; }
  .pager button:disabled { opacity: 0.35; cursor: default; }
  .pgn { min-width: 30px; text-align: center; }
  .empty, .meldtag { color: #5b6270; font-size: 11px; }
  .meldtag { margin-left: 8px; }

  /* center column: shared wall + controls below */
  .center { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .piles { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; background: #12161d; border: 1px solid #232a34; border-radius: 12px; padding: 12px; }
  .pile { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 10px; color: #8b95a3; }
  .seehint { color: #6ea8ff; }
  .extrarow { display: flex; gap: 6px; align-items: flex-start; }
  .stack { width: var(--cw, 92px); height: calc(var(--cw, 92px) * 1.391); border-radius: 9px; border: 1px solid #3a4250;
           background: repeating-linear-gradient(45deg, #20242d, #20242d 5px, #272c37 5px, #272c37 10px); }
  .stack.back-main { background: url("/images/Base/back-main.png") center/cover no-repeat, repeating-linear-gradient(45deg, #20242d, #20242d 5px, #272c37 5px, #272c37 10px); }
  .stack.back-faith { background: url("/images/Base/back-faith.png") center/cover no-repeat, repeating-linear-gradient(45deg, #2a2030, #2a2030 5px, #372c3a 5px, #372c3a 10px); }
  .stack.banish { background: #1a1414; border-style: dashed; }
  .stack.empty-pile { background: #14181f; border-style: dashed; }

  /* controls (below the wall, centered) */
  .control { display: flex; flex-direction: column; align-items: center; gap: 8px; background: #12161d; border: 1px solid #232a34; border-radius: 10px; padding: 10px 14px; }
  .phase { color: #aeb6c2; }
  .phase b { color: #9fb6e0; }
  .banner { border-radius: 7px; padding: 6px 8px; font-size: 12px; }
  .guess { width: 48px; font: inherit; padding: 2px 5px; border-radius: 5px; border: 1px solid #39414e; background: #11151c; color: #eaeef4; }
  .respond { background: #2a2333; border: 1px solid #7a5; color: #e7ddff; }
  .targeting { background: #3a2320; border: 1px solid #f96; color: #ffd9c0; }
  .melding { background: #2a2a1a; border: 1px solid #dca832; color: #ffe8b0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .choice { background: #1e2a33; border: 1px solid #6ea8ff; color: #cfe6ff; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .orclick { color: #8fb8e8; font-size: 11px; }
  .cardlink { font: inherit; padding: 0 2px; background: none; border: none; cursor: pointer;
              color: #6ea8ff; text-decoration: underline dotted; border-radius: 3px; }
  .cardlink:hover { color: #93c0ff; background: #1e3148; }
  .cardlink.on { color: #bfe3ff; background: #1e3148; }
  .melding button.hot:disabled { opacity: 0.4; cursor: default; }

  .slot { position: relative; display: inline-flex; border-radius: 8px; }
  .slot.targetable { box-shadow: 0 0 0 2px #f96, 0 0 12px #f96a; cursor: crosshair; }
  .mwrap { position: relative; display: inline-flex; border-radius: 8px; transition: opacity 0.12s; }
  .mwrap.meldable { box-shadow: 0 0 0 2px #dca832, 0 0 12px #dca83288; cursor: pointer; }
  .mwrap.targetable { box-shadow: 0 0 0 2px #f96, 0 0 12px #f96a; cursor: crosshair; }
  .mwrap.dim { opacity: 0.32; }
  .row.hand.dim { opacity: 0.4; }

  .buttons { display: flex; flex-wrap: wrap; gap: 6px; }
  button { font: inherit; background: #232730; color: #d6dae0; border: 1px solid #39414e; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  button:hover { background: #2c313c; }
  button.hot { border-color: #4f7; color: #cffbe0; }
  button.pass { border-color: #c97; color: #ffd9b0; padding: 2px 10px; }
  .toggle { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; justify-content: center; color: #8b95a3; font-size: 12px; }
  /* Free mode: toggle sits next to the dev tab; the action bar floats bottom-centre */
  .freetab { position: fixed; left: 96px; bottom: 12px; z-index: 80; font: inherit; font-size: 12px;
             background: #33251a; color: #ffd9a8; border: 1px solid #ad7c5c; border-radius: 7px; padding: 5px 11px; cursor: pointer; }
  .freetab:hover { background: #443023; }
  .freetab.on { background: #4a2f16; border-color: #ff9d45; color: #ffc98a; box-shadow: 0 0 0 2px #ff9d4533; }
  .freebar { position: fixed; left: 50%; transform: translateX(-50%); bottom: 12px; z-index: 80;
             display: flex; align-items: center; gap: 6px; flex-wrap: wrap; max-width: 92vw;
             background: #1d150ef5; border: 1px solid #ad7c5c; border-radius: 9px; padding: 7px 10px; box-shadow: 0 8px 26px #000a; }
  .freebar b { color: #ffc98a; font-size: 12px; margin-right: 2px; }
  .freebar button { font: inherit; font-size: 12px; background: #33251a; color: #ffd9a8; border: 1px solid #6e5138; border-radius: 6px; padding: 3px 9px; cursor: pointer; }
  .freebar button:hover:not(:disabled) { background: #443023; }
  .freebar button:disabled { opacity: 0.4; cursor: default; }
  .freebar .x { border-color: #6e5138; padding: 3px 7px; }
  .freebar .mp { color: #d9b18a; font-size: 11px; }
  .toggle button { padding: 2px 10px; }
  .toggle button.on { border-color: #6ea8ff; color: #bfe3ff; background: #1e3148; }
  .logbtn { margin-left: 6px; }
</style>
