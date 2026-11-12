# Goldsmiths Site & AI Builder 1.2.5
# Runs as uid 1000 (review V1), keeps data in a named volume (D16),
# stops cleanly on SIGTERM (F3), ships the front-end bundle (F22).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
# curl is used by the entrypoint and the healthcheck
RUN apk add --no-cache curl
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js entrypoint.sh ./
# /data owned by 1000 inside the image, so a named volume mounted on it is
# created writable for the app user on first use. No runtime chown anywhere.
RUN chmod 0755 /app/entrypoint.sh \
 && mkdir -p /data/sites /data/uploads /data/orders \
 && chown -R 1000:1000 /app /data

USER 1000:1000
ENV NODE_ENV=production \
    PORT=8090 \
    DATA_DIR=/data \
    OLLAMA_URL=http://ollama:11434 \
    MODEL=qwen2.5-coder:1.5b

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8090/healthz || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
