FROM node:20-alpine

# OS deps: build tools per native modules + chromium per puppeteer
RUN apk add --no-cache python3 make g++ chromium

WORKDIR /app

# 1. Solo manifest dependencies — cache-friendly (rebuild solo se package.json cambia)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && \
    npm rebuild bcrypt --build-from-source && \
    npm cache clean --force

# 2. Codice applicativo (cambia spesso, layer separato)
COPY services ./services
COPY routes ./routes
COPY middleware ./middleware
COPY db ./db
COPY server.js seed.js seed-farmacri.js ./

EXPOSE 3001

CMD ["node", "server.js"]
