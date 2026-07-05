<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Card from "./Card.svelte";
  import CardDetail from "./CardDetail.svelte";
  import baseSet from "@root/base_set.json";
  import manifest from "@root/manifest.json";
  import type { CardView } from "@net/session.js";
  import type { ManualView, ManualAction, ManualCardView, ManualZone } from "@net/manual.js";

  export let view: ManualView;
  export let mySeat: number;

  const dispatch = createEventDispatcher<{ manual: ManualAction }>();
  const act = (a: ManualAction) => dispatch("manual", a);

  const CARD = new Map((baseSet as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const MAN = manifest as Record<string, { image?: string; deck?: string }>;
  const nameOf = (cid: string | null) => (cid ? CARD.get(cid) ?? cid : "");
  const frontOf = (c: ManualCardView) => (!c.faceDown && c.cardId && MAN[c.cardId]?.image ? `/${MAN[c.cardId]!.image}` : undefined);
  // card-back art for face-down/hidden cards: the deck's back when known to the viewer, else Main.
  const backOf = (c: ManualCardView) => `/images/Base/${c.cardId && MAN[c.cardId]?.deck === "Faith" ? "back-faith" : "back-main"}.png`;
  // Card.svelte face: hide the id when face-down so it draws the card back (not the name).
  const face = (c: ManualCardView): CardView => ({
    iid: c.iid, cardId: c.faceDown ? null : c.cardId, tapped: c.tapped, faceDown: c.faceDown,
    counters: c.counters, overlays: c.overlays.length || undefined,
  });
  // hover preview uses the real (viewer-known) id so you can read your own face-down cards
  const preview = (c: ManualCardView): CardView | null => (c.cardId ? { iid: c.iid, cardId: c.cardId, counters: c.counters } : null);

  let hovered: CardView | null = null;

  // ---- mahjong seating (mirrors the Automatic board) -----------------------
  const SLOTS: Record<number, Record<number, string>> = { 2: { 1: "top" }, 3: { 1: "right", 2: "top" }, 4: { 1: "right", 2: "top", 3: "left" } };
  $: order = view.players.map((p) => p.pid);
  function slotFor(pid: number): string {
    const n = order.length;
    const off = (order.indexOf(mySeat) - order.indexOf(pid) + n) % n;
    return (SLOTS[n] ?? SLOTS[4])![off] ?? "top";
  }
  $: me = view.players.find((p) => p.pid === mySeat) ?? view.players[0]!;
  $: opponents = view.players.filter((p) => p.pid !== me.pid);

  // ---- drag & drop ---------------------------------------------------------
  let dragIid: string | null = null;
  function onDragStart(e: DragEvent, iid: string) { dragIid = iid; e.dataTransfer?.setData("text/plain", iid); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; }
  const allowDrop = (e: DragEvent) => e.preventDefault();
  function drop(e: DragEvent, zone: ManualZone, player?: number) {
    e.preventDefault();
    if (dragIid) act({ do: "move", iid: dragIid, to: { zone, player } });
    dragIid = null;
  }
  // drop a card ONTO a specific hand card -> insert it at that slot (drag to reorder).
  // works for a card dragged within the hand and for one dragged in from elsewhere.
  function dropHandCard(e: DragEvent, targetIid: string) {
    e.preventDefault(); e.stopPropagation();
    const hand = (me.hand ?? []).map((c) => c.iid);
    if (!dragIid || dragIid === targetIid) { dragIid = null; return; }
    const from = hand.indexOf(dragIid), to = hand.indexOf(targetIid);
    const without = hand.filter((x) => x !== dragIid);
    let idx = without.indexOf(targetIid);
    if (idx < 0) { dragIid = null; return; }
    if (from >= 0 && from < to) idx += 1; // dragged rightward past the target -> land after it
    act({ do: "move", iid: dragIid, to: { zone: "hand", player: me.pid, pos: idx } });
    dragIid = null;
  }
  // drop a searched card ONTO another in the search panel -> reorder that pile
  function dropPeekCard(e: DragEvent, targetIid: string, zone: "mainDeck" | "faithDeck" | "discard" | "banish") {
    e.preventDefault(); e.stopPropagation();
    if (!view.peek || !dragIid || dragIid === targetIid) { dragIid = null; return; }
    const ids = view.peek.cards.map((c) => c.iid);
    const from = ids.indexOf(dragIid), to = ids.indexOf(targetIid);
    if (from < 0 || to < 0) { dragIid = null; return; }
    const without = ids.filter((x) => x !== dragIid);
    let idx = without.indexOf(targetIid);
    if (from < to) idx += 1;
    without.splice(idx, 0, dragIid);
    act({ do: "reorder", zone, order: without });
    dragIid = null;
  }
  // discard a random card from your own hand
  function discardRandom() {
    const hand = me.hand ?? [];
    if (!hand.length) return;
    const iid = hand[Math.floor(Math.random() * hand.length)]!.iid;
    act({ do: "move", iid, to: { zone: "discard" } });
  }
  // place a board card at the EXACT drop point (free positioning, like Tabletop Simulator).
  // stored as a PERCENTAGE of the field so it scales to any screen and stays consistent
  // across viewers; the card is centred on the drop point (see .cw.field translate).
  function dropBoard(e: DragEvent, player: number) {
    e.preventDefault();
    if (!dragIid) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(8, Math.min(92, ((e.clientX - r.left) / r.width) * 100));
    const y = Math.max(14, Math.min(86, ((e.clientY - r.top) / r.height) * 100));
    act({ do: "move", iid: dragIid, to: { zone: "board", player, x, y } });
    dragIid = null;
  }

  // ---- card action menu ----------------------------------------------------
  let menuIid: string | null = null;
  let menuX = 0, menuY = 0;
  function onCardClick(e: MouseEvent, iid: string) {
    e.stopPropagation();
    menuIid = menuIid === iid ? null : iid; menuX = e.clientX; menuY = e.clientY;
  }
  const closeMenus = () => { menuIid = null; pileMenu = null; };
  const menu = (a: ManualAction) => { act(a); menuIid = null; };

  // ---- pile menus + search -------------------------------------------------
  let pileMenu: { zone: "mainDeck" | "faithDeck" | "discard" | "banish"; x: number; y: number } | null = null;
  let searchN = 5;
  function onPileClick(e: MouseEvent, zone: "mainDeck" | "faithDeck" | "discard" | "banish") {
    e.stopPropagation();
    pileMenu = pileMenu?.zone === zone ? null : { zone, x: e.clientX, y: e.clientY };
  }

  // keep a popup fully on-screen: shift it left/up if it would overflow the viewport
  function place(node: HTMLElement, pos: { x: number; y: number }) {
    const apply = (p: { x: number; y: number }) => {
      const m = 8;
      const r = node.getBoundingClientRect();
      const x = Math.max(m, Math.min(p.x, window.innerWidth - r.width - m));
      const y = Math.max(m, Math.min(p.y, window.innerHeight - r.height - m));
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
    };
    apply(pos);
    return { update: apply };
  }
</script>

<svelte:window on:click={closeMenus} />

<div class="table">
  <!-- center: shared wall (drop targets + click menus) -->
  <div class="center" style="grid-area:center">
    <div class="piles">
      <div class="pile">
        <button class="stack back-main" on:click={(e) => onPileClick(e, "mainDeck")} on:dragover={allowDrop} on:drop={(e) => drop(e, "mainDeck")} aria-label="main deck"></button>
        <span>Main {view.mainDeckCount}</span>
      </div>
      <div class="pile">
        <button class="stack back-faith" on:click={(e) => onPileClick(e, "faithDeck")} on:dragover={allowDrop} on:drop={(e) => drop(e, "faithDeck")} aria-label="faith deck"></button>
        <span>Faith {view.faithDeckCount}</span>
      </div>
      <div class="pile" on:dragover={allowDrop} on:drop={(e) => drop(e, "discard")} role="group" aria-label="discard">
        {#if view.discard[0]}
          {@const d = view.discard[0]}
          <Card card={face(d)} name={nameOf(d.cardId)} front={frontOf(d)} back={backOf(d)} clickable
            on:click={(e) => onPileClick(e, "discard")} on:mouseenter={() => (hovered = preview(d))} on:mouseleave={() => (hovered = null)} />
        {:else}<button class="stack empty-pile" on:click={(e) => onPileClick(e, "discard")} aria-label="discard"></button>{/if}
        <span>Discard {view.discard.length}</span>
      </div>
      <div class="pile" on:dragover={allowDrop} on:drop={(e) => drop(e, "banish")} role="group" aria-label="banish">
        {#if view.banish[0]}
          {@const b = view.banish[0]}
          <Card card={face(b)} name={nameOf(b.cardId)} front={frontOf(b)} back={backOf(b)} clickable
            on:click={(e) => onPileClick(e, "banish")} on:mouseenter={() => (hovered = preview(b))} on:mouseleave={() => (hovered = null)} />
        {:else}<button class="stack banish" on:click={(e) => onPileClick(e, "banish")} aria-label="banish"></button>{/if}
        <span>Banish {view.banish.length}</span>
      </div>
    </div>
    <div class="hint">drag cards between zones · drag within your hand to reorder · click a card or pile for actions</div>
  </div>

  <!-- opponents, placed by mahjong slot -->
  {#each opponents as p (p.pid)}
    {@const slot = slotFor(p.pid)}
    <div class="oppseat {slot}" style="grid-area:{slot}">
      <div class="nameplate np-{slot}"><b>{view.names?.[p.pid] ?? `P${p.pid}`} (P{p.pid})</b><span class="tag">✋ {p.handCount}</span></div>
      <div class="board" on:dragover={allowDrop} on:drop={(e) => dropBoard(e, p.pid)} role="group" aria-label="player {p.pid} board">
        {#each p.board as c (c.iid)}
          <span class="cw field" class:tgt={c.targeted} style="left:{c.x}%;top:{c.y}%" draggable="true" on:dragstart={(e) => onDragStart(e, c.iid)}>
            <Card card={face(c)} name={nameOf(c.cardId)} front={frontOf(c)} back={backOf(c)} clickable
              on:click={(e) => onCardClick(e, c.iid)} on:mouseenter={() => (hovered = preview(c))} on:mouseleave={() => (hovered = null)} />
          </span>
        {:else}<span class="bhint">empty</span>{/each}
      </div>
    </div>
  {/each}

  <!-- you (bottom) -->
  <div class="seat self" style="grid-area:self">
    <div class="board self-board" on:dragover={allowDrop} on:drop={(e) => dropBoard(e, me.pid)} role="group" aria-label="your board">
      {#each me.board as c (c.iid)}
        <span class="cw field" class:tgt={c.targeted} style="left:{c.x}%;top:{c.y}%" draggable="true" on:dragstart={(e) => onDragStart(e, c.iid)}>
          <Card card={face(c)} name={nameOf(c.cardId)} front={frontOf(c)} back={backOf(c)} clickable
            on:click={(e) => onCardClick(e, c.iid)} on:mouseenter={() => (hovered = preview(c))} on:mouseleave={() => (hovered = null)} />
        </span>
      {:else}<span class="bhint">drag cards here</span>{/each}
    </div>
    <div class="nameplate self-plate">
      <b>{view.names?.[me.pid] ?? `P${me.pid}`} (P{me.pid})</b>
      <button class="minibtn" on:click={discardRandom} disabled={!(me.hand?.length)} title="discard a random card from your hand">🎲 Discard random</button>
    </div>
    <div class="row hand" on:dragover={allowDrop} on:drop={(e) => drop(e, "hand", me.pid)} role="group" aria-label="your hand">
      {#each me.hand ?? [] as c (c.iid)}
        <span class="cw" draggable="true" on:dragstart={(e) => onDragStart(e, c.iid)} on:dragover={allowDrop} on:drop={(e) => dropHandCard(e, c.iid)}>
          <Card card={face(c)} name={nameOf(c.cardId)} front={frontOf(c)} back={backOf(c)} clickable
            on:click={(e) => onCardClick(e, c.iid)} on:mouseenter={() => (hovered = preview(c))} on:mouseleave={() => (hovered = null)} />
        </span>
      {:else}<span class="empty">empty hand</span>{/each}
    </div>
  </div>
</div>

<CardDetail card={hovered} />

<!-- card action menu -->
{#if menuIid}
  {@const id = menuIid}
  <div class="menu" use:place={{ x: menuX, y: menuY }} role="menu">
    <button on:click|stopPropagation={() => menu({ do: "tap", iid: id })}>Tap / Untap</button>
    <button on:click|stopPropagation={() => menu({ do: "flip", iid: id })}>Flip face-down / up</button>
    <button on:click|stopPropagation={() => menu({ do: "target", iid: id })}>Target</button>
    <button on:click|stopPropagation={() => menu({ do: "counter", iid: id, name: "counter", delta: 1 })}>+ Counter</button>
    <button on:click|stopPropagation={() => menu({ do: "counter", iid: id, name: "counter", delta: -1 })}>− Counter</button>
    <div class="sep"></div>
    <button on:click|stopPropagation={() => menu({ do: "move", iid: id, to: { zone: "hand", player: mySeat } })}>To hand</button>
    <button on:click|stopPropagation={() => menu({ do: "move", iid: id, to: { zone: "board", player: mySeat, x: 50, y: 50 } })}>To your board</button>
    <button on:click|stopPropagation={() => menu({ do: "move", iid: id, to: { zone: "discard" } })}>Discard</button>
    <button on:click|stopPropagation={() => menu({ do: "move", iid: id, to: { zone: "banish" } })}>Banish</button>
    <button on:click|stopPropagation={() => menu({ do: "move", iid: id, to: { zone: "mainDeck", pos: "top" } })}>To deck (top)</button>
    <button on:click|stopPropagation={() => menu({ do: "move", iid: id, to: { zone: "mainDeck", pos: "bottom" } })}>To deck (bottom)</button>
  </div>
{/if}

<!-- pile menu -->
{#if pileMenu}
  {@const z = pileMenu.zone}
  <div class="menu" use:place={{ x: pileMenu.x, y: pileMenu.y }} role="menu" on:click|stopPropagation>
    {#if z === "mainDeck" || z === "faithDeck"}
      <button on:click={() => { act({ do: "draw", player: mySeat, zone: z, n: 1 }); pileMenu = null; }}>Draw 1</button>
      <button on:click={() => { act({ do: "draw", player: mySeat, zone: z, n: 5 }); pileMenu = null; }}>Draw 5</button>
      <div class="srch"><span>Search top</span><input type="number" min="1" max="99" bind:value={searchN} /><button on:click={() => { act({ do: "peek", zone: z, count: searchN }); pileMenu = null; }}>Go</button></div>
    {/if}
    <button on:click={() => { act({ do: "peek", zone: z }); pileMenu = null; }}>Search (all)</button>
    <button on:click={() => { act({ do: "shuffle", zone: z }); pileMenu = null; }}>Shuffle</button>
  </div>
{/if}

<!-- search panel -->
{#if view.peek}
  {@const pk = view.peek}
  {@const pileShuffle = pk.zone === "mainDeck" || pk.zone === "faithDeck" || pk.zone === "discard" || pk.zone === "banish" ? pk.zone : null}
  <div class="search">
    <div class="shead">Searching {pk.zone} — {pk.cards.length} card{pk.cards.length === 1 ? "" : "s"} (top → bottom · drag to reorder)</div>
    <div class="sgrid">
      {#each pk.cards as c (c.iid)}
        <div class="scard" draggable="true" on:dragstart={(e) => onDragStart(e, c.iid)} on:dragover={allowDrop}
          on:drop={(e) => { if (pileShuffle) dropPeekCard(e, c.iid, pileShuffle); }}>
          <Card card={face(c)} name={nameOf(c.cardId)} front={frontOf(c)} back={backOf(c)} clickable
            on:mouseenter={() => (hovered = preview(c))} on:mouseleave={() => (hovered = null)} />
          <div class="srow">
            <button on:click={() => act({ do: "move", iid: c.iid, to: { zone: "hand", player: mySeat } })} title="to hand">✋</button>
            <button on:click={() => act({ do: "move", iid: c.iid, to: { zone: pk.zone, pos: "top" } })} title="to top">⤒</button>
            <button on:click={() => act({ do: "move", iid: c.iid, to: { zone: pk.zone, pos: "bottom" } })} title="to bottom">⤓</button>
          </div>
        </div>
      {/each}
    </div>
    <div class="sfoot">
      {#if pileShuffle}<button on:click={() => act({ do: "shuffle", zone: pileShuffle })}>Shuffle</button>{/if}
      <button class="close" on:click={() => act({ do: "unpeek" })}>Done</button>
    </div>
  </div>
{/if}

<style>
  .table {
    display: grid; grid-template-columns: 1fr auto 1fr; grid-template-rows: auto minmax(150px, 1fr) auto;
    grid-template-areas: ".  top  ." "left center right" "self self self";
    gap: 10px; padding: 10px; height: calc(100dvh - 44px); box-sizing: border-box; overflow: hidden;
    align-items: center; justify-items: center;
    /* card width + gaps scale with the viewport (bounded) so nothing gets cut off */
    --cw: clamp(50px, 6vw, 92px);
    --side-gap: clamp(20px, 7vw, 200px);
  }
  .oppseat { border: 1px solid #2b313b; border-radius: 10px; padding: 8px; background: #161a22; display: flex; align-items: center; gap: 6px; }
  .oppseat.top { flex-direction: column-reverse; }
  .oppseat.left { flex-direction: row-reverse; justify-self: end; margin-right: var(--side-gap); }
  .oppseat.right { flex-direction: row; justify-self: start; margin-left: var(--side-gap); }
  .seat.self { justify-self: stretch; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  /* free-position field: sized by the viewport but with a FIXED aspect ratio, so a
     card's percentage (x,y) maps to the same relative spot for every viewer */
  .board { position: relative; width: clamp(220px, 36vw, 460px); aspect-ratio: 46 / 25; border: 1px solid #2b313b; border-radius: 10px; background: #11151c; flex: 0 0 auto; }
  .bhint { position: absolute; inset: 0; display: grid; place-items: center; color: #5b6270; font-size: 11px; pointer-events: none; }
  .cw { position: relative; display: grid; place-items: center; border-radius: 8px; }
  .cw.field { position: absolute; transform: translate(-50%, -50%); } /* (x%,y%) is the card's centre */
  .cw :global(img) { pointer-events: none; } /* so drag/click hit the wrapper/button, not the art */
  .cw.tgt { box-shadow: 0 0 0 2px #ffb454, 0 0 12px #ffb45499; z-index: 1; }
  .cw[draggable="true"] { cursor: grab; }
  .nameplate { display: flex; align-items: center; gap: 8px; color: #cdd4de; flex-wrap: wrap; justify-content: center; }
  .minibtn { font: inherit; font-size: 11px; background: #1a212c; color: #cdd4de; border: 1px solid #39414e; border-radius: 6px; padding: 2px 9px; cursor: pointer; }
  .minibtn:hover:not(:disabled) { background: #222a36; }
  .minibtn:disabled { opacity: 0.4; cursor: default; }
  .nameplate.np-left { writing-mode: vertical-rl; }
  .nameplate.np-right { writing-mode: vertical-rl; transform: rotate(180deg); }
  .self-plate { margin: 10px 0 4px; }
  .tag { font-size: 11px; color: #8b95a3; background: #20252f; border-radius: 10px; padding: 1px 7px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: center; }
  .row.hand { background: #11151c; border: 1px dashed #2b313b; border-radius: 10px; padding: 12px 10px; min-height: calc(var(--cw, 92px) * 1.391 + 16px); min-width: 120px; }
  .center { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .piles { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; background: #12161d; border: 1px solid #232a34; border-radius: 12px; padding: 12px; }
  .pile { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 10px; color: #8b95a3; }
  .stack { width: var(--cw, 92px); height: calc(var(--cw, 92px) * 1.391); border-radius: 9px; border: 1px solid #3a4250; cursor: pointer; padding: 0;
           background: repeating-linear-gradient(45deg, #20242d, #20242d 5px, #272c37 5px, #272c37 10px); }
  .stack.back-main { background: url("/images/Base/back-main.png") center/cover no-repeat, repeating-linear-gradient(45deg, #20242d, #20242d 5px, #272c37 5px, #272c37 10px); }
  .stack.back-faith { background: url("/images/Base/back-faith.png") center/cover no-repeat, repeating-linear-gradient(45deg, #2a2030, #2a2030 5px, #372c3a 5px, #372c3a 10px); }
  .stack.banish { background: #1a1414; border-style: dashed; }
  .stack.empty-pile { background: #14181f; border-style: dashed; }
  .empty { color: #5b6270; font-size: 11px; }
  .hint { color: #69707c; font-size: 11px; text-align: center; }
  .menu { position: fixed; z-index: 50; background: #161c26; border: 1px solid #39414e; border-radius: 8px; padding: 4px; display: flex; flex-direction: column; min-width: 160px; max-height: calc(100dvh - 16px); overflow-y: auto; box-shadow: 0 6px 20px #0008; }
  .menu button { font: inherit; font-size: 12px; text-align: left; background: none; border: none; color: #d6dae0; padding: 6px 10px; border-radius: 5px; cursor: pointer; }
  .menu button:hover { background: #232c39; }
  .sep { height: 1px; background: #2b3340; margin: 3px 0; }
  .srch { display: flex; align-items: center; gap: 5px; padding: 4px 8px; font-size: 12px; color: #aeb6c2; }
  .srch input { width: 46px; font: inherit; background: #0f141b; border: 1px solid #39414e; color: #d6dae0; border-radius: 5px; padding: 3px 5px; }
  .srch button { font: inherit; font-size: 12px; background: #1e3148; border: 1px solid #355; color: #bfe3ff; border-radius: 5px; padding: 3px 9px; cursor: pointer; }
  .search { position: fixed; inset: 8% 12%; z-index: 60; background: #0f141bf5; border: 1px solid #355; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; }
  .shead { color: #9fb6e0; margin-bottom: 10px; }
  .sgrid { flex: 1; overflow: auto; display: flex; flex-wrap: wrap; gap: 10px; align-content: flex-start; }
  .scard { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: grab; }
  .srow { display: flex; gap: 3px; }
  .srow button { font: inherit; font-size: 12px; background: #1a212c; border: 1px solid #39414e; color: #cdd4de; border-radius: 4px; cursor: pointer; padding: 1px 6px; }
  .srow button:hover { background: #222a36; }
  .sfoot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  .sfoot button { font: inherit; background: #1a212c; border: 1px solid #39414e; color: #cdd4de; border-radius: 7px; padding: 7px 16px; cursor: pointer; }
  .sfoot .close { background: #16271d; color: #cffbe0; border-color: #4f7; }
</style>
