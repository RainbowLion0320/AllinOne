# Stage 1: Build Portable PC Bridge + Mobile PWA (skipping Electron desktop workspace)
FROM node:22-alpine AS builder
WORKDIR /app

ARG PUBLIC_RELAY_URL=""
ARG VITE_RELAY_URL=""
ARG VITE_APK_URL=""
ENV PUBLIC_RELAY_URL=${PUBLIC_RELAY_URL}
ENV VITE_RELAY_URL=${VITE_RELAY_URL}
ENV VITE_APK_URL=${VITE_APK_URL}

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/dsh-mobile-hub/package.json ./packages/dsh-mobile-hub/
COPY packages/mobile-app/package.json ./packages/mobile-app/

# Include root devDependencies (esbuild) explicitly rather than relying on transitive vite hoisting
RUN npm ci --include-workspace-root=true \
    --workspace=@allinone/shared \
    --workspace=dsh-mobile-hub \
    --workspace=@allinone/mobile-app

COPY scripts ./scripts
COPY packages/shared ./packages/shared
COPY packages/dsh-mobile-hub ./packages/dsh-mobile-hub
COPY packages/mobile-app ./packages/mobile-app

# Normalize setup.sh line endings (defense-in-depth), build single-file PC bridge into
# packages/mobile-app/public/downloads/allinone-bridge.mjs, then bundle Mobile PWA
RUN sed -i 's/\r$//' packages/mobile-app/public/setup.sh \
    && npm run build:bridge \
    && npm --workspace=@allinone/mobile-app run build

# Stage 2: Slim production Relay Server + Static PWA
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/relay-server/package.json ./packages/relay-server/

RUN npm ci --omit=dev --include-workspace-root=false \
    --workspace=@allinone/shared \
    --workspace=@allinone/relay-server

COPY --from=builder /app/packages/shared ./packages/shared
COPY packages/relay-server ./packages/relay-server
COPY --from=builder /app/packages/mobile-app/dist ./packages/mobile-app/dist

RUN mkdir -p /app/packages/relay-server/data && chown -R node:node /app/packages/relay-server/data
USER node

EXPOSE 8787
EXPOSE 3478/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "packages/relay-server/src/index.js"]
