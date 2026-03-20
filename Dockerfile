# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsdown.config.ts ./
COPY src/ src/

RUN pnpm run build

# --- Production stage ---
FROM node:22-alpine

WORKDIR /app

# No runtime dependencies — all imports are node:* built-ins
COPY --from=build /app/dist/ dist/
COPY fixtures/ fixtures/

EXPOSE 4010

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--fixtures", "./fixtures", "--host", "0.0.0.0"]
