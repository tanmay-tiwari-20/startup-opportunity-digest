FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WHATSAPP_RELAY_PORT=18764 \
    WHATSAPP_RELAY_BIND_HOST=0.0.0.0

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown 1000:1000 /data \
    && chmod 700 /data

COPY --chown=1000:1000 . .
USER 1000:1000
EXPOSE 18764
# This is a run-once worker. A host scheduler is required for repeated runs.
CMD ["node", "cloud-main.mjs", "--batch"]
