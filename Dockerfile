# syntax=docker/dockerfile:1

# chitra runs on beamup-deploy (dokku), which expects a container that listens
# on $PORT. dist/ is gitignored, so the TypeScript has to be compiled here —
# `npm start` alone would fail with ERR_MODULE_NOT_FOUND.

# ── build: compile TypeScript with devDeps present ──────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

# ── deps: production node_modules only (typescript/vitest/tsx stay behind) ───
# playwright's postinstall would fetch ~170MB of browsers into a layer we never
# copy, so skip it here and install once, explicitly, in the runtime stage.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./

# All three providers scrape through playwright, so Chromium and its shared libs
# are required, not optional. Installed before dropping privileges, into a path
# that stays readable and executable by the unprivileged user.
RUN npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* /tmp/*

USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]