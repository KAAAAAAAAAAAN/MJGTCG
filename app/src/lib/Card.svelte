<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { CardView } from "@net/session.js";
  import baseSet from "@root/base_set.json";
  const dispatchOv = createEventDispatcher<{ overlays: CardView }>();
  export let card: CardView;
  export let name = "";
  export let front: string | undefined = undefined; // front-art URL (face-up only)
  export let back: string | undefined = undefined; // card-back art URL (face-down / hidden)
  export let selected = false;
  export let clickable = false;
  export let big = false; // render at 2× (BIG ICHIHIME on the board)
  let imgError = false;
  let backError = false;
  const V = (n: number | null | undefined) => (n === null || n === undefined ? "☆" : String(n));
  $: showImg = card.cardId !== null && !card.faceDown && !!front && !imgError;
  $: showBack = (card.cardId === null || card.faceDown) && !!back && !backError;

  // printed (base) stats, to flag when a card's effective stats have been modified
  const BASE = new Map(
    (baseSet as { id: string; atk?: number; def?: number; value?: number; star?: boolean }[]).map((c) => [
      c.id,
      { atk: c.atk, def: c.def, value: c.star ? null : c.value ?? null },
    ]),
  );
  $: base = card.cardId ? BASE.get(card.cardId) : undefined;
  // ☆ (null) printed ATK/DEF render as 0 by default (atkOf/defOf collapse null->0), so
  // compare against 0 — else a ☆-stat card (Shamiko) always looks "modified".
  $: modified =
    !!base && card.cardId !== null && !card.faceDown &&
    ((card.atk !== undefined && card.atk !== (base.atk ?? 0)) ||
      (card.def !== undefined && card.def !== (base.def ?? 0)) ||
      (card.value !== undefined && (card.value ?? null) !== (base.value ?? null)));
  // one badge per counter TYPE (an icon for the known ones, else the name's initial)
  const CTR_ICON: Record<string, string> = { code: "🍕", sheep: "🐑", poison: "☠" };
  $: ctrs = card.counters ? Object.entries(card.counters).filter(([, n]) => n > 0) : [];
</script>

<button
  class="card"
  class:sel={selected}
  class:tapped={card.tapped}
  class:fd={card.faceDown}
  class:hidden={card.cardId === null && !card.faceDown}
  class:clickable
  class:big
  class:art={showImg}
  on:click
  on:mouseenter
  on:mouseleave
  title={card.cardId ?? (card.faceDown ? "face-down" : "hidden")}
>
  {#if showImg}
    <img class="front" src={front} alt={name} on:error={() => (imgError = true)} />
  {:else if showBack}
    <img class="backimg" src={back} alt="card back" on:error={() => (backError = true)} />
  {:else if card.cardId === null || card.faceDown}
    <span class="back">{card.faceDown ? "⤵" : "🂠"}</span>
  {:else}
    <span class="nm">{name || card.cardId}</span>
    <span class="spacer">{(card.tribes && card.tribes[0]) || ""}</span>
    <span class="stats">
      <span class="atk" title="ATK">{card.atk ?? "?"}</span>
      <span class="def" title="DEF">{card.def ?? "?"}</span>
      <span class="val" title="VALUE">{V(card.value)}</span>
    </span>
  {/if}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  {#if card.overlays}<span class="ov" title="view overlaid cards" on:click|stopPropagation={() => dispatchOv("overlays", card)}>+{card.overlays}</span>{/if}
  {#if modified}<span class="modbadge" title="stats modified">±</span>{/if}
  {#if card.stunned}<span class="stun" title="stunned — cannot attack or use Actives">💫</span>{/if}
  {#if ctrs.length}
    <span class="ctrs">
      {#each ctrs as [nm, n] (nm)}
        <span class="ctr" title="{nm} counter{n > 1 ? 's' : ''} ×{n}">{CTR_ICON[nm] ?? nm.charAt(0).toUpperCase()}{n}</span>
      {/each}
    </span>
  {/if}
  {#if card.token}<span class="tok" title="Token — created by an effect, not a deck card">TOKEN</span>{/if}
</button>

<style>
  .card {
    position: relative;
    width: var(--cw, 92px);
    height: calc(var(--cw, 92px) * 1.391);
    flex: 0 0 auto;
    border: 1px solid #3a4250;
    border-radius: 9px;
    background: linear-gradient(160deg, #232a36, #1a1f29);
    color: #d6dae0;
    padding: 5px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font: 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    cursor: default;
    transition: transform 0.12s, box-shadow 0.12s, border-color 0.12s;
  }
  .card.art { padding: 0; }
  /* BIG ICHIHIME: twice the size of a normal card on the board */
  .card.big { width: calc(var(--cw, 92px) * 2); height: calc(var(--cw, 92px) * 2 * 1.391); z-index: 1; }
  .card.clickable { cursor: pointer; }
  .card.clickable:hover { border-color: #6ea8ff; transform: translateY(-3px); }
  .card.sel { border-color: #5f9; box-shadow: 0 0 0 2px #5f9a, 0 0 12px #2f8a; }
  /* rotated 90° = tapped; extra horizontal margin so it doesn't overlap neighbours
     (overflow each side ≈ (128-92)/2 = 18px) */
  .card.tapped { transform: rotate(90deg); margin: 0 calc(var(--cw, 92px) * 0.2); }
  .card.tapped.clickable:hover { transform: rotate(90deg) translateY(-3px); }
  .card.fd, .card.hidden {
    background: repeating-linear-gradient(45deg, #20242d, #20242d 5px, #272c37 5px, #272c37 10px);
    align-items: center;
    justify-content: center;
  }
  .front { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .backimg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .nm { font-weight: 600; font-size: 11px; max-height: 42px; overflow: hidden; }
  .spacer { flex: 1; color: #69707c; display: flex; align-items: center; justify-content: center; font-size: 11px; }
  .stats { display: flex; justify-content: space-between; gap: 2px; }
  .stats .atk { color: #ff9b9b; }
  .stats .def { color: #9bd0ff; }
  .stats .val { color: #ffe08a; margin-left: auto; }
  .back { font-size: 20px; color: #4a5160; }
  .stun { position: absolute; top: -7px; left: -7px; font-size: 13px; z-index: 2; filter: drop-shadow(0 1px 2px #000); }
  .ov { position: absolute; top: -8px; right: -8px; min-width: 20px; height: 20px; padding: 0 6px;
        display: grid; place-items: center; background: #394; color: #eafff0; border-radius: 10px;
        font-size: 13px; font-weight: 700; line-height: 1; z-index: 4; cursor: pointer; box-shadow: 0 1px 3px #0008; }
  /* counter badges: one pill per counter type (icon/initial + count) */
  .ctrs { position: absolute; bottom: -7px; left: -7px; display: flex; gap: 3px; z-index: 3; pointer-events: none; }
  .ctr { min-width: 18px; height: 18px; padding: 0 4px;
         display: grid; place-items: center; border-radius: 9px; font-size: 11px; font-weight: 700;
         color: #1a1f29; background: #ffb454; box-shadow: 0 0 0 1px #1a1f29, 0 1px 3px #0008; }
  .tok { position: absolute; bottom: -7px; right: -7px; padding: 2px 5px; border-radius: 8px;
         font-size: 8px; font-weight: 800; letter-spacing: 0.5px; color: #f0e6ff; background: #6d4d9c;
         box-shadow: 0 0 0 1px #1a1f29, 0 1px 3px #0008; z-index: 3; pointer-events: none; }
  .ov:hover { background: #4b6; }
  /* "stats modified" marker, between the top and the centre of the card art */
  .modbadge {
    position: absolute; top: 26%; left: 50%; transform: translate(-50%, -50%); z-index: 2;
    width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center;
    font-weight: 800; font-size: 20px; color: #1a1f29; background: #ffe08a;
    box-shadow: 0 0 0 1px #1a1f29, 0 1px 3px #0008; pointer-events: none;
  }
</style>
