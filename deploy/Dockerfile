# Stage 1: Build Mobile PWA
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/relay-server/package.json ./packages/relay-server/
COPY packages/mobile-app/package.json ./packages/mobile-app/

RUN npm install --workspaces --include-workspace-root=false --workspace=@allinone/shared --workspace=@allinone/relay-server --workspace=@allinone/mobile-app

COPY packages/shared ./packages/shared
COPY packages/mobile-app ./packages/mobile-app
RUN npm --workspace=@allinone/mobile-app run build

# Stage 2: Slim production Relay Server + Static PWA
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY packages/relay-server ./packages/relay-server
COPY --from=builder /app/packages/mobile-app/dist ./packages/mobile-app/dist

EXPOSE 8787
CMD ["node", "packages/relay-server/src/index.js"]
