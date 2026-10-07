# Two stages: build with the full toolchain, run with only what's needed.

FROM node:22-alpine AS build
WORKDIR /app
# Copy manifests first. As long as dependencies don't change, Docker reuses
# the cached `npm ci` layer and rebuilds take seconds, not minutes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/redis/package.json packages/redis/
COPY packages/server/package.json packages/server/
COPY packages/bench/package.json packages/bench/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npx tsc -b packages/server && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
# Don't run as root inside the container.
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=2s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "packages/server/dist/main.js"]
