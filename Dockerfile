# ======================
# 1. Builder Stage
# ======================
FROM node:20-alpine AS builder

WORKDIR /app

# Install build deps needed only for native escpos-usb
RUN apk add --no-cache python3 make g++ libusb-dev eudev-dev

COPY package*.json ./

# Install full deps (native modules compile here)
RUN npm install --ignore-scripts

# Copy source
COPY . .

# Rebuild native deps
RUN npm rebuild

# ======================
# 2. Runtime Stage
# ======================
FROM node:20-alpine

WORKDIR /app

# Install ONLY required runtime libs (not the full build chain)
RUN apk add --no-cache libusb eudev

# Bring built node_modules + source
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/*.js ./
COPY --from=builder /app/package*.json ./

# Create non-root user
RUN addgroup -S nodejs && adduser -S nodejs -G nodejs
USER nodejs

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "server.js"]
