# syntax=docker/dockerfile:1
# Backend image for ephemeral preview environments (issue #264).
# Multi-stage: build TS + Prisma client, ship a slim runtime.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=staging
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 --start-period=25s \
  CMD wget -qO- http://127.0.0.1:4000/health/ready > /dev/null 2>&1 || exit 1
CMD ["node", "dist/index.js"]
