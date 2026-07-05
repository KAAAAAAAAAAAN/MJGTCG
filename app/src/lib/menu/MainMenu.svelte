<script lang="ts">
  import { createEventDispatcher } from "svelte";
  export let nickname = "Anon";
  const dispatch = createEventDispatcher<{ create: void; join: void }>();
  const REPO = "https://github.com/KAAAAAAAAAAAN/MJGTCG";
</script>

<div class="menu">
  <h1>MJGTCG</h1>
  <label class="nick">
    <span>Nickname:</span>
    <input maxlength="20" placeholder="Anon" bind:value={nickname} on:blur={() => { if (!nickname.trim()) nickname = "Anon"; }} />
  </label>
  <button class="big create" on:click={() => dispatch("create")}>Create game</button>
  <button class="big join" on:click={() => dispatch("join")}>Join game</button>
  <a class="gh" href={REPO} target="_blank" rel="noreferrer" title="source code on GitHub">
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
    <span>GitHub</span>
  </a>
</div>

<style>
  .menu { max-width: 360px; margin: 84px auto; display: flex; flex-direction: column; gap: 14px; text-align: center; }
  h1 { color: #eaeef4; letter-spacing: 0.06em; margin: 0 0 18px; font-size: 30px; }
  .big { font: inherit; font-size: 16px; padding: 14px; border-radius: 10px; cursor: pointer; border: 1px solid #39414e; background: #1a212c; color: #d6dae0; }
  .big:hover { background: #222a36; }
  .create { border-color: #4f7; color: #cffbe0; background: #16271d; }
  .create:hover { background: #1d3528; }
  .join { border-color: #6ea8ff; color: #bfe3ff; background: #162232; }
  .join:hover { background: #1d2e44; }
  .gh { align-self: center; display: inline-flex; align-items: center; gap: 7px; text-decoration: none;
        color: #8b95a3; font-size: 12px; padding: 6px 11px; border-radius: 8px; border: 1px solid transparent; }
  .gh:hover { color: #eaeef4; background: #1a212c; border-color: #2f3947; }
  .gh svg { display: block; }
  .nick { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; text-align: left; }
  .nick span { color: #aeb6c2; font-size: 13px; }
  .nick input { flex: 1; min-width: 0; font: inherit; font-size: 14px; background: #0f141c; color: #eaeef4;
                border: 1px solid #39414e; border-radius: 8px; padding: 8px 10px; }
  .nick input:focus { outline: none; border-color: #6ea8ff; }
</style>
