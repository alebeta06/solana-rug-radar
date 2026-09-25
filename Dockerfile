# Node 24 is required: lossless JSON parsing uses JSON.parse source text access (see src/core/json.ts).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config
# Redacted real frames (one+ per type), so the replay works for anyone cloning the repo:
# raw captures in ./data are git-ignored because they embed the API key.
COPY tests/fixtures/events.jsonl ./samples/events.jsonl
USER node
# Phase 1: replay captured frames through the normalization layer.
# `data` = your own captures (mounted, optional); `samples` = the bundled redacted frames.
CMD ["node", "dist/replay.js", "data", "samples"]
