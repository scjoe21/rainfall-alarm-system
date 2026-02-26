FROM node:20-alpine

WORKDIR /app

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

# Install server dependencies
COPY package*.json ./
RUN npm install

# Install client dependencies
COPY client/package*.json ./client/
RUN npm install --prefix client

# Copy source files
COPY server/ ./server/
COPY data/ ./data/
COPY client/ ./client/

# Build React client
RUN npm run build --prefix client

EXPOSE 3000

CMD ["node", "server/server.js"]
