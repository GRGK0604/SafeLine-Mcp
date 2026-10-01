FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node src ./src
COPY --chown=node:node docs ./docs

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
