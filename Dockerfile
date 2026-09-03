# Node 24+: node:sqlite is flagged before 23.4, and this bot depends on it.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY prompts ./prompts

# Configuration and the database share one mounted path, so a deployment needs a
# single volume.
ENV PAKLED_DATA_DIR=/data
VOLUME /data

# Ceremonies are narrated over several minutes. A shutdown that does not wait for
# one strands its in-flight row, so give it room; the bot bounds its own wait and
# recovers a stranded row on the next start regardless.
STOPSIGNAL SIGTERM

USER node
CMD ["node", "dist/index.js", "start"]
