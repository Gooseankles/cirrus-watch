# Node 26 is LTS until April 2029 (Node 24 until April 2028). Pinned by digest so
# a build uses exactly the image that was scanned before; Dependabot moves the
# digest (both lines) each week when a new 26-alpine image is out.
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The image that runs: no npm, npx, corepack or yarn. The app never uses them
# and their bundled packages were most of what the security scan reported.
FROM node:26-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216
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
