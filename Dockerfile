FROM node:22-bookworm-slim

# python3/make/g++ let better-sqlite3 fall back to a source build if no
# prebuilt binary matches this platform; ca-certificates for the prebuild
# download and any outbound HTTPS calls.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared-types packages/shared-types
COPY apps/backend apps/backend
COPY apps/frontend apps/frontend
COPY config config

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @open-log/frontend build

ENV NODE_ENV=production
WORKDIR /app/apps/backend
EXPOSE 4000

CMD ["pnpm", "start"]
