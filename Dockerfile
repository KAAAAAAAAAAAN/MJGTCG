# MJGTCG game server (Colyseus). Portable image — works on Fly.io, Railway,
# Render, or any Docker host. The client (static SvelteKit build) is hosted
# separately (Cloudflare Pages); this image only runs the WebSocket server.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# install only production deps (colyseus + tsx). package-lock is committed so
# `npm ci` is reproducible.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# server source + the data files it reads at runtime (base_set / parsed / manifest).
# The client-only bits (app/, images/) are excluded via .dockerignore.
COPY tsconfig.json ./
COPY src ./src
COPY base_set.json base_set_parsed.json manifest.json ./

# the server binds process.env.PORT (Railway/Render) or falls back to 2567 (Fly
# routes to this internal port). Colyseus listens on 0.0.0.0 by default.
EXPOSE 2567
CMD ["npm", "run", "server"]
