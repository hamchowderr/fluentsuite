# FluentSuite over Streamable HTTP. Build: docker build -t fluentsuite .
# Run: see the README's "Deploy" section for the required environment.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && rm -rf node_modules packages/*/node_modules \
  && pnpm install --frozen-lockfile --prod --offline

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    FLUENTSUITE_HTTP_HOST=0.0.0.0 \
    FLUENTSUITE_HTTP_PORT=3333
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FLUENTSUITE_HTTP_PORT||3333)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/server/dist/bin.js", "--http"]
