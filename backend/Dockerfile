FROM node:20-alpine

RUN apk add --no-cache python3 make g++ chromium

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production && npm rebuild bcrypt --build-from-source

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
