FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public

# App Service: set WEBSITES_PORT=7070, and DATA_DIR=/home/data with
# WEBSITES_ENABLE_APP_SERVICE_STORAGE=true so state survives restarts.
ENV PORT=7070
EXPOSE 7070

USER node
CMD ["node", "server.js"]
