# ── AutoNode Pulse — Dashboard Dockerfile ────────────────────────────────
# Multi-stage: Vite builds static assets, Nginx serves them.
# Final image is ~25 MB (nginx:alpine) vs ~200 MB if Node were included.

# ── Stage 1: Build static assets ─────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# VITE_API_URL is intentionally left unset here so the bundle uses relative
# URLs (/api/...). Nginx (stage 2) proxies those to the backend service,
# giving us the same topology as Vite's dev proxy — zero code difference
# between dev, Docker staging, and production.
RUN npm run build

# ── Stage 2: Nginx static file server ────────────────────────────────────
FROM nginx:1.27-alpine AS runner

# Replace default config with our SPA + API proxy config
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
