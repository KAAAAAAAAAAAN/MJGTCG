import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Aliases come from svelte.config kit.alias (it generates the Vite + TS mappings).
// fs.allow lets Vite read the shared engine/net files + base_set.json in ../.
export default defineConfig({
  plugins: [sveltekit()],
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
});
