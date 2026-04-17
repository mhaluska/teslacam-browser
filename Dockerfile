FROM node:24-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts


FROM node:24-slim AS runtime

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src/server ./src/server
COPY --chown=node:node src/renderer ./src/renderer

USER node

EXPOSE 8088
VOLUME ["/data"]

ENTRYPOINT ["node", "src/server/server.js", "/data"]
