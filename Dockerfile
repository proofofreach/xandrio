# Pin the multi-architecture Node 24 LTS image. Dependabot proposes reviewed
# digest updates; the scheduled rebuild refreshes packages available from the
# pinned Debian base and detects new image vulnerabilities.
FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS deps

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    poppler-utils \
    unzip \
  && npm ci --omit=dev \
  && npx playwright install --with-deps chromium \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/*

FROM node:26-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb

ARG VERSION=dev
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Xandrio" \
      org.opencontainers.image.description="Self-hosted personal reading server" \
      org.opencontainers.image.source="https://github.com/ProofOfReach/alexandrio" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.created="$BUILD_DATE"

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8181
ENV HOST=0.0.0.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV KOKORO_AUTO_START=false
ENV CHATTERBOX_AUTO_START=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    ocrmypdf \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    unzip \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /ms-playwright /ms-playwright
COPY --chown=node:node . .

RUN npx playwright install-deps chromium \
  && mkdir -p /app/data /app/cache /app/tmp \
  && chown -R node:node /app/data /app/cache /app/tmp /ms-playwright

USER node

EXPOSE 8181

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8181/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
