FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev --omit=optional

COPY src ./src

RUN addgroup -S nodejs && adduser -S nodejs -G nodejs \
  && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3001

# Plain http, because the bridge serves plain http: it listens only on the compose network, where
# both callers are containers on this host and there is no hop to encrypt.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "\
    const port = process.env.PORT || 3001;\
    require('http').get('http://localhost:'+port+'/health', \
      (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

CMD ["node", "src/server.js"]