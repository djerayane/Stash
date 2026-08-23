FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @stash/sync build && pnpm run build:server

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/sync/package.json ./packages/sync/package.json
COPY --from=build /app/packages/sync/dist ./packages/sync/dist
COPY --from=build /app/dist ./dist
USER root
RUN mkdir -p /var/lib/stash/attachments && chown -R node:node /var/lib/stash
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
