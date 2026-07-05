<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Card from "./Card.svelte";
  import type { CardView } from "@net/session.js";
  import baseSet from "@root/base_set.json";
  import manifest from "@root/manifest.json";

  export let title: string;
  export let cards: CardView[] = []; // the cards to reorder (index 0 = top of deck)

  const dispatch = createEventDispatcher<{ hover: CardView | null; done: string[] }>();
  const CARD = new Map((baseSet as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const MAN = manifest as Record<string, { image?: string }>;
  const nameOf = (c: CardView) => (c.cardId ? (CARD.get(c.cardId) ?? c.cardId) : "");
  const frontOf = (c: CardView) => (c.cardId && MAN[c.cardId]?.image ? `/${MAN[c.cardId]!.image}` : undefined);

  // `order` = current arrangement (top first); `seq` = iids clicked since the last
  // Confirm, in click order. Nothing is sent until "Done reordering".
  let order: CardView[] = [...cards];
  let seq: string[] = [];
  $: allPicked = seq.length === order.length && order.length > 0;

  function pick(iid: string) {
    seq = seq.includes(iid) ? seq.filter((x) => x !== iid) : [...seq, iid];
  }
  function confirm() {
    if (!allPicked) return;
    order = seq.map((iid) => order.find((c) => c.iid === iid)!); // rearrange to the picked order
    seq = []; // reset numbering so the player can re-order again if they like
  }
  function done() {
    dispatch("done", order.map((c) => c.iid));
  }
</script>

<div class="backdrop">
  <div class="panel">
    <div class="head">
      <b>{title}</b>
      <span class="hint">click the cards in order (1 = first)</span>
    </div>
    <div class="grid">
      {#each order as c (c.iid)}
        {@const n = seq.indexOf(c.iid) + 1}
        <span class="rwrap" class:picked={n > 0}>
          {#if n > 0}<span class="numbadge">{n}</span>{/if}
          <Card card={c} name={nameOf(c)} front={frontOf(c)} clickable
            on:click={() => pick(c.iid)}
            on:mouseenter={() => dispatch("hover", c)} on:mouseleave={() => dispatch("hover", null)} />
        </span>
      {/each}
    </div>
    <div class="foot">
      <span class="state">{seq.length}/{order.length} picked</span>
      <button class="confirm" disabled={!allPicked} on:click={confirm}>Confirm order</button>
      <button class="done" on:click={done}>Done reordering</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: 60; background: #000a;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .panel {
    background: #141923; border: 1px solid #2f3947; border-radius: 12px;
    max-width: 720px; max-height: 80vh; width: 100%; display: flex; flex-direction: column;
    box-shadow: 0 12px 40px #000c;
  }
  .head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #232a34; }
  .head b { color: #eaeef4; }
  .hint { color: #69707c; font-size: 11px; }
  .grid { display: flex; flex-wrap: wrap; gap: 10px; padding: 16px; overflow: auto; justify-content: center; }
  .rwrap { position: relative; border-radius: 8px; }
  .rwrap.picked { box-shadow: 0 0 0 2px #6ea8ff, 0 0 14px #6ea8ffaa; }
  /* a prominent order number overlaid on the picked card (like the targeting marker) */
  .numbadge {
    position: absolute; inset: 0; z-index: 5; pointer-events: none;
    display: grid; place-items: center; border-radius: 8px;
    background: #6ea8ff33; color: #fff; font-weight: 800; font-size: 40px;
    text-shadow: 0 0 6px #000, 0 1px 2px #000;
  }
  .foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid #232a34; }
  .state { color: #8b95a3; font-size: 12px; margin-right: auto; }
  .confirm, .done { font: inherit; border-radius: 6px; padding: 4px 12px; cursor: pointer; border: 1px solid #39414e; }
  .confirm { background: #232730; color: #d6dae0; }
  .confirm:disabled { opacity: 0.4; cursor: default; }
  .confirm:not(:disabled):hover { background: #2c313c; }
  .done { background: #2e7d4f; color: #eafff2; border-color: #2e7d4f; }
  .done:hover { background: #379a61; }
</style>
