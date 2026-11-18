# Node 26 is LTS until April 2029 (Node 24 until April 2028). Pinned by digest so
# a build uses exactly the image that was scanned before; Dependabot moves the
# digest (both lines) each week when a new 26-alpine image is out.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The image that runs: no npm, npx, corepack or yarn. The app never uses them
# and their bundled packages were most of what the security scan reported.
FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
     /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js VERSION ./
COPY src ./src
COPY public ./public

# App Service: set WEBSITES_PORT=7070, and DATA_DIR=/home/data with
# WEBSITES_ENABLE_APP_SERVICE_STORAGE=true so state survives restarts.
ENV PORT=7070
EXPOSE 7070

RUN mkdir -p /app/data /app/logs /home/data && chown node:node /app/data /app/logs /home/data

USER node
CMD ["node", "server.js"]
