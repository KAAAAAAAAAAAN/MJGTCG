<script lang="ts">
  import { createEventDispatcher } from "svelte";
  export let nickname = "Anon";
  const dispatch = createEventDispatcher<{ create: void; join: void; demo: void }>();
</script>

<div class="menu">
  <h1>MJGTCG</h1>
  <label class="nick">
    <span>Nickname:</span>
    <input maxlength="20" placeholder="Anon" bind:value={nickname} on:blur={() => { if (!nickname.trim()) nickname = "Anon"; }} />
  </label>
  <button class="big create" on:click={() => dispatch("create")}>Create game</button>
  <button class="big join" on:click={() => dispatch("join")}>Join game</button>
  <button class="link" on:click={() => dispatch("demo")}>view demo board</button>
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
  .link { background: none; border: none; color: #69707c; cursor: pointer; font: inherit; font-size: 12px; }
  .link:hover { color: #9aa3b1; }
  .nick { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; text-align: left; }
  .nick span { color: #aeb6c2; font-size: 13px; }
  .nick input { flex: 1; min-width: 0; font: inherit; font-size: 14px; background: #0f141c; color: #eaeef4;
                border: 1px solid #39414e; border-radius: 8px; padding: 8px 10px; }
  .nick input:focus { outline: none; border-color: #6ea8ff; }
</style>
