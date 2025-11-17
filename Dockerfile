FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --omit=dev

COPY src ./src
COPY keys ./keys

# Create non-root user
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs \
  && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start the app
CMD ["node", "src/server.js"]
