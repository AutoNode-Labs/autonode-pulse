# ── AutoNode Pulse — Backend API Dockerfile ───────────────────────────────
# Multi-stage build: separates dependency installation from the runtime image,
# ensuring the final image contains zero build toolchain artifacts.

# ── Stage 1: Install production dependencies ──────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app

# Copy manifests first — Docker layer-caches this step until package*.json changes.
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: Production runtime ───────────────────────────────────────────
FROM node:24-alpine AS runner

# Security: run as a dedicated non-root user.
# Containers with UID 0 (root) elevate risk if the process is compromised.
RUN addgroup -g 1001 -S pulse && adduser -u 1001 -S pulse -G pulse

WORKDIR /app

# Copy only the production node_modules from the deps stage
COPY --from=deps --chown=pulse:pulse /app/node_modules ./node_modules

# Copy application source — exclude CLI (bin/) and dashboard to minimise attack surface
COPY --chown=pulse:pulse src/ ./src/
COPY --chown=pulse:pulse package.json ./

USER pulse

# PORT is injected at runtime by the platform (Render, Fly, ECS, etc.)
EXPOSE 3000

# exec form ensures SIGTERM reaches the Node process directly, not a shell wrapper.
# Required for graceful shutdown to work (server.js listens for SIGTERM).
CMD ["node", "src/server.js"]
