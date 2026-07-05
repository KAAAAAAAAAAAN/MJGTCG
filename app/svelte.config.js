import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // client-only SPA (ssr=false): static build with an index.html fallback.
    // Also the right adapter for Cloudflare Pages later.
    adapter: adapter({ fallback: "index.html" }),
    // share the engine + net + repo root from the parent (../src, ..)
    alias: {
      "@engine": "../src/engine",
      "@net": "../src/net",
      "@root": "..",
    },
  },
};
