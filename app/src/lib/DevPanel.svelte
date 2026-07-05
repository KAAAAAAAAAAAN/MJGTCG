<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import baseSet from "@root/base_set.json";

  const dispatch = createEventDispatcher<{ spawn: string }>();
  type Rec = { id: string; name: string; atk: number; def: number; value: number | null; star?: boolean };
  const ALL = (baseSet as Rec[]).map((c) => ({ id: c.id, name: c.name, atk: c.atk, def: c.def, v: c.star ? "☆" : String(c.value ?? 0) }));

  let open = false;
  let q = "";
  $: needle = q.trim().toLowerCase();
  $: hits = needle ? ALL.filter((c) => c.name.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)) : ALL;
</script>

<div class="dev" class:open>
  <button class="tab" on:click={() => (open = !open)} title="dev: add a card to your hand">🛠 {open ? "▾" : "▸"} dev</button>
  {#if open}
    <div class="panel">
      <input placeholder="search name or id…" bind:value={q} />
      <div class="list">
        {#each hits as c (c.id)}
          <button class="row" on:click={() => dispatch("spawn", c.id)} title="add to your hand">
            <span class="nm">{c.name}</span>
            <span class="id">{c.id}</span>
            <span class="st">{c.atk}/{c.def}/{c.v}</span>
          </button>
        {:else}
          <span class="none">no match</span>
        {/each}
      </div>
      <div class="foot">{hits.length} cards · click to add to your hand</div>
    </div>
  {/if}
</div>

<style>
  .dev { position: fixed; left: 12px; bottom: 12px; z-index: 80; font-size: 12px; }
  .tab { font: inherit; background: #2a2233; color: #e7ddff; border: 1px solid #7a5cad; border-radius: 7px; padding: 5px 11px; cursor: pointer; }
  .tab:hover { background: #352a44; }
  .panel { position: absolute; bottom: 34px; left: 0; width: 320px; background: #141019f5; border: 1px solid #4b3a66;
           border-radius: 10px; box-shadow: 0 10px 32px #000b; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
  input { font: inherit; background: #0f0c14; color: #e7ddff; border: 1px solid #3a2f4d; border-radius: 6px; padding: 5px 8px; }
  .list { max-height: 320px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .row { display: grid; grid-template-columns: 1fr auto; grid-template-areas: "nm st" "id st"; gap: 0 8px;
         text-align: left; font: inherit; background: transparent; color: #cdc3dd; border: 1px solid transparent; border-radius: 6px; padding: 4px 7px; cursor: pointer; }
  .row:hover { background: #251d33; border-color: #5a4880; }
  .nm { grid-area: nm; font-weight: 600; color: #e7ddff; }
  .id { grid-area: id; font-size: 10px; color: #8b7fa6; }
  .st { grid-area: st; align-self: center; font-size: 10px; color: #b69bff; white-space: nowrap; }
  .none { color: #69707c; padding: 6px; }
  .foot { color: #69707c; font-size: 10px; }
</style>
