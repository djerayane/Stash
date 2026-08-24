FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/api-client/package.json ./packages/api-client/package.json
COPY --from=build /app/packages/api-client/dist ./packages/api-client/dist
COPY --from=build /app/packages/api-client/node_modules/@stash ./packages/api-client/node_modules/@stash
COPY --from=build /app/packages/domain-types/package.json ./packages/domain-types/package.json
COPY --from=build /app/packages/domain-types/dist ./packages/domain-types/dist
COPY --from=build /app/packages/rich-text/package.json ./packages/rich-text/package.json
COPY --from=build /app/packages/rich-text/dist ./packages/rich-text/dist
COPY --from=build /app/packages/rich-text/node_modules/@stash ./packages/rich-text/node_modules/@stash
COPY --from=build /app/packages/sync/package.json ./packages/sync/package.json
COPY --from=build /app/packages/sync/dist ./packages/sync/dist
COPY --from=build /app/packages/sync/node_modules/@stash ./packages/sync/node_modules/@stash
COPY --from=build /app/packages/validation/package.json ./packages/validation/package.json
COPY --from=build /app/packages/validation/dist ./packages/validation/dist
COPY --from=build /app/packages/validation/node_modules/@stash ./packages/validation/node_modules/@stash
RUN node -e "Promise.all(['@stash/rich-text','@stash/sync'].map(name => import(name)))"
RUN apk add --no-cache postgresql17-client
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER root
RUN mkdir -p /var/lib/stash/attachments /var/lib/stash/backups && chown -R node:node /var/lib/stash
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
