# Multi-stage build: compile TS + native deps inside the image so git-connected
# deploys (Railway) work. The old single-stage COPY dist/ assumed a pre-built
# tree and omitted prompts/, which agents.config.ts reads at module load.
#
# better-sqlite3 (direct + transitive via spectrum-ts → @photon-ai/imessage-kit)
# is a native module with no prebuilds for every platform, so the BUILD stage
# carries the gyp toolchain; the runtime stage stays slim by copying the
# compiled, dev-pruned node_modules instead of re-installing.
FROM node:20-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# .npmrc scopes @biboyang425 to GitHub Packages with ${NODE_AUTH_TOKEN}; Railway
# passes the NODE_AUTH_TOKEN service variable as this build ARG (a read:packages
# PAT), which npm ci expands to authenticate the private @biboyang425/bia-shared
# install. The token lives only in the build stage; the runtime stage copies the
# already-installed node_modules and never sees it.
COPY package*.json tsconfig.json .npmrc ./
ARG NODE_AUTH_TOKEN
RUN npm ci
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:20-slim
WORKDIR /app
COPY package*.json ./
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
# Runtime-read assets: prompts/ (agent prompts at module load), data/ (spatial
# geojson + calendar), assets/ (onboarding showcase + vcf).
COPY prompts/ ./prompts/
COPY data/ ./data/
COPY assets/ ./assets/
ENV NODE_ENV=production
EXPOSE 3001
# Railway injects PORT; default to 3001 for local docker runs.
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
