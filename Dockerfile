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
# The demo capture (real frames of 17 tokens of the 2026-09-26 night, key-free, built by
# src/calibration/demo.ts), so a jury without an API key sees the real detector at work.
# Raw captures in ./data are git-ignored because they embed the API key.
COPY samples ./samples
USER node
EXPOSE 8080
# Live Blur stream when SOLAMI_API_KEY is set; otherwise replays the demo capture at 40× through
# the same pipeline and keeps the dashboard up. Dashboard: http://localhost:8080/
CMD ["node", "dist/main.js"]
