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
# Redacted real frames, so the replay (plan B, no API key) works for anyone cloning the repo:
# raw captures in ./data are git-ignored because they embed the API key.
COPY tests/fixtures/events.jsonl tests/fixtures/stream-sample.jsonl ./samples/
USER node
EXPOSE 8080
# Phase 2: ingestion. Live Blur stream when SOLAMI_API_KEY is set; otherwise replays
# ./data (mounted, optional) + the bundled samples through the same pipeline.
CMD ["node", "dist/main.js"]
