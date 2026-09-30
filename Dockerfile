# syntax=docker/dockerfile:1

# ── build: install everything, generate the Prisma client, build the web app, keep runtime deps ──
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN yarn install --immutable \
 && yarn workspace @ganttlines/db generate \
 && yarn workspace @ganttlines/web build \
 && yarn workspaces focus @ganttlines/server --production \
 && rm -rf apps/web/node_modules apps/web/src apps/web/test .yarn/cache

# ── runtime: Node + PostgreSQL client tools (17 and 18) for backups ──
FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 postgresql-client-18 \
 && apt-get purge -y curl gnupg && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN printf '#!/bin/sh\nexec node --import tsx /app/apps/server/src/cli.ts "$@"\n' > /usr/local/bin/ganttlines \
 && chmod +x /usr/local/bin/ganttlines \
 && install -d -o node -g node /backups

ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    BIND=0.0.0.0 \
    PORT=3000 \
    BACKUP_DIR=/backups \
    WEB_DIR=/app/apps/web/dist \
    PRISMA_HIDE_UPDATE_MESSAGE=1
USER node
EXPOSE 3000
VOLUME ["/backups"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["ganttlines"]
CMD ["start"]
