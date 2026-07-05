<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import CardDetail from "./CardDetail.svelte";
  import baseSet from "@root/base_set.json";
  export let lines: string[] = [];
  const dispatch = createEventDispatcher<{ close: void }>();

  // card ids mentioned in a log line become clickable links -> preview popup.
  // Longest-first so no id can shadow a longer one; special chars escaped (MJG-77*).
  const CARDS = new Map((baseSet as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const IDS = [...CARDS.keys()].sort((a, b) => b.length - a.length);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const RE = new RegExp(`(${IDS.map(esc).join("|")})`, "g");
  /** Split a line into plain-text and card-link segments. */
  function segs(line: string): { t: string; id?: string }[] {
    const out: { t: string; id?: string }[] = [];
    let last = 0;
    for (const m of line.matchAll(RE)) {
      const i = m.index ?? 0;
      if (i > last) out.push({ t: line.slice(last, i) });
      out.push({ t: m[0], id: m[0] });
      last = i + m[0].length;
    }
    if (last < line.length) out.push({ t: line.slice(last) });
    return out;
  }

  let preview: string | null = null; // cardId being previewed (click a link)
  const toggle = (id: string) => (preview = preview === id ? null : id);
</script>

<svelte:window on:keydown={(e) => e.key === "Escape" && (preview ? (preview = null) : dispatch("close"))} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="backdrop" on:click={() => dispatch("close")}>
  <div class="panel" on:click|stopPropagation={() => (preview = null)}>
    <div class="head">
      <b>Game log</b>
      <span class="hint">newest first · click a card id to preview it</span>
      <button class="x" on:click={() => dispatch("close")}>✕</button>
    </div>
    <div class="lines">
      {#each [...lines].reverse() as l}
        <div>
          {#each segs(l) as s}
            {#if s.id}
              <button class="cardlink" class:on={preview === s.id} title={CARDS.get(s.id)}
                on:click|stopPropagation={() => toggle(s.id ?? "")}>{s.t}</button>
            {:else}{s.t}{/if}
          {/each}
        </div>
      {:else}
        <span class="empty">no log yet</span>
      {/each}
    </div>
  </div>
</div>

<!-- the card preview popup (CardDetail sits at z-index 70, above this backdrop) -->
<CardDetail card={preview ? { iid: "log-preview", cardId: preview } : null} />

<style>
  .backdrop { position: fixed; inset: 0; z-index: 60; background: #000a; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .panel { background: #141923; border: 1px solid #2f3947; border-radius: 12px; max-width: 640px; max-height: 80vh; width: 100%; display: flex; flex-direction: column; box-shadow: 0 12px 40px #000c; }
  .head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #232a34; }
  .head b { color: #eaeef4; }
  .hint { color: #69707c; font-size: 11px; }
  .x { margin-left: auto; background: #232730; color: #d6dae0; border: 1px solid #39414e; border-radius: 6px; padding: 2px 9px; cursor: pointer; }
  .x:hover { background: #2c313c; }
  .lines { padding: 12px 14px; overflow: auto; font: 12px/1.4 ui-monospace, monospace; color: #aeb6c2; }
  .lines div { padding: 2px 0; border-bottom: 1px solid #1b212b; }
  .cardlink { font: inherit; padding: 0 1px; background: none; border: none; cursor: pointer;
              color: #6ea8ff; text-decoration: underline dotted; border-radius: 3px; }
  .cardlink:hover { color: #93c0ff; background: #1e3148; }
  .cardlink.on { color: #bfe3ff; background: #1e3148; }
  .empty { color: #69707c; }
</style>
