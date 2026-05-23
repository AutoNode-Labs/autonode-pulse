# ── AutoNode Pulse — Backend API Dockerfile ───────────────────────────────
# Multi-stage build: separates dependency installation from the runtime image,
# ensuring the final image contains zero build toolchain artifacts.

# ── Stage 1: Install production dependencies ──────────────────────────────
# node:20-alpine is LTS — smaller attack surface than full Debian images.
# Layer-cache manifests before source so `npm ci` only reruns on dep changes.
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: Production runtime ───────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Copy only the production node_modules from the deps stage — no build toolchain
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Copy application source — bin/ and dashboard are excluded via .dockerignore
COPY --chown=node:node src/ ./src/
COPY --chown=node:node package.json ./

# node:alpine ships with a built-in non-root 'node' user (UID 1000).
# Dropping to it here means a compromised process cannot write outside /app.
USER node

# PORT is injected at runtime by the platform (Render, Fly, ECS, etc.)
EXPOSE 3000

# exec form — SIGTERM lands directly on the Node process, not a shell wrapper.
# This is what triggers the graceful shutdown handler in server.js.
CMD ["node", "src/server.js"]
