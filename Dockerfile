FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY src ./src

RUN addgroup -S nodejs && adduser -S nodejs -G nodejs \
  && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "\
    const port = process.env.PORT || 3001;\
    const useHttps = process.env.SSL_CERT_PATH && process.env.SSL_KEY_PATH;\
    const mod = useHttps ? require('https') : require('http');\
    const opts = useHttps ? { host:'localhost', port, path:'/health', rejectUnauthorized:false } : 'http://localhost:'+port+'/health';\
    mod.get(opts, (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1));"

CMD ["node", "src/server.js"]