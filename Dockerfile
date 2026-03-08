# Install production dependencies in a throwaway layer so the final image
# doesn't carry devDependencies or the bun install cache.
FROM oven/bun:1-alpine AS deps

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Bun runs TypeScript natively — no separate compile step needed.
# APP_VERSION is injected by the CI workflow (format: YYYY.MM.DD.HHmm).
FROM oven/bun:1-alpine

# Re-declare so the ARG is in scope for this stage
ARG APP_VERSION=dev

WORKDIR /app

# Non-root user for security
RUN addgroup -S sse && adduser -S sse -G sse
USER sse

# Copy package manifest (needed so Bun can resolve workspace-relative imports)
COPY --chown=sse:sse package.json ./

# Copy production node_modules from deps stage
COPY --from=deps --chown=sse:sse /app/node_modules ./node_modules

# Copy application source
COPY --chown=sse:sse src/ ./src/

ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}

# Bake version into OCI image label (other labels come from docker/metadata-action)
LABEL org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.title="sse-postgres-server"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["bun", "src/index.ts"]
