FROM node:24-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts


FROM node:24-slim AS runtime

WORKDIR /app

RUN groupadd --system --gid 1000 app \
 && useradd  --system --uid 1000 --gid app --home-dir /app --shell /usr/sbin/nologin app

COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app src/server ./src/server
COPY --chown=app:app src/renderer ./src/renderer

USER app

EXPOSE 8088
VOLUME ["/data"]

ENTRYPOINT ["node", "src/server/server.js", "/data"]
