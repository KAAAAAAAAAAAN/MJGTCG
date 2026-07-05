<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Card from "./Card.svelte";
  import type { CardView, MeldView } from "@net/session.js";
  import baseSet from "@root/base_set.json";
  import manifest from "@root/manifest.json";

  export let title: string;
  export let melds: MeldView[] = [];

  const dispatch = createEventDispatcher<{ close: void; hover: CardView | null }>();
  const CARD = new Map((baseSet as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const MAN = manifest as Record<string, { image?: string }>;
  const nameOf = (c: CardView) => (c.cardId ? (CARD.get(c.cardId) ?? c.cardId) : "");
  const frontOf = (c: CardView) => (c.cardId && MAN[c.cardId]?.image ? `/${MAN[c.cardId]!.image}` : undefined);
</script>

<svelte:window on:keydown={(e) => e.key === "Escape" && dispatch("close")} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="backdrop" on:click={() => dispatch("close")}>
  <div class="panel" on:click|stopPropagation>
    <div class="head">
      <b>{title}</b>
      <span class="hint">{melds.length}/4 melds</span>
      <button class="x" on:click={() => dispatch("close")}>✕</button>
    </div>
    <div class="melds">
      {#each melds as m, i}
        <div class="meld">
          <span class="kind">#{i + 1} {m.kind}{m.kan ? " · Kan" : ""}{#if m.values} · ☆={m.values.join("-")}{/if}</span>
          <div class="cards">
            {#each m.cards as c (c.iid)}
              <Card card={c} name={nameOf(c)} front={frontOf(c)}
                on:mouseenter={() => dispatch("hover", c)} on:mouseleave={() => dispatch("hover", null)} />
            {/each}
          </div>
        </div>
      {:else}
        <span class="empty">no melds yet</span>
      {/each}
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
    max-width: 620px; max-height: 80vh; width: 100%; display: flex; flex-direction: column;
    box-shadow: 0 12px 40px #000c;
  }
  .head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #232a34; }
  .head b { color: #eaeef4; }
  .hint { color: #69707c; font-size: 11px; }
  .x { margin-left: auto; background: #232730; color: #d6dae0; border: 1px solid #39414e; border-radius: 6px; padding: 2px 9px; cursor: pointer; }
  .x:hover { background: #2c313c; }
  .melds { display: flex; flex-direction: column; gap: 10px; padding: 14px; overflow: auto; }
  .meld { border: 1px solid #232a34; border-radius: 9px; padding: 8px 10px; background: #11161f; }
  .kind { color: #ffe8b0; font-size: 12px; text-transform: capitalize; }
  .cards { display: flex; gap: 8px; margin-top: 6px; }
  .empty { color: #69707c; }
</style>
