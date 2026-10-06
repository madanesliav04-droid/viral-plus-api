FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY railway-worker/package.json ./railway-worker/package.json
RUN cd railway-worker && npm install --omit=dev

COPY edit-renderer/package.json ./edit-renderer/package.json
RUN cd edit-renderer && npm install

COPY railway-worker/src ./railway-worker/src
COPY edit-renderer/src ./edit-renderer/src

WORKDIR /app/railway-worker
ENV NODE_ENV=production
ENV EDIT_RENDERER_DIR=/app/edit-renderer

CMD ["npm", "start"]
