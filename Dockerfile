FROM node:22-slim

# better-sqlite3 ships prebuilt binaries for common platforms; python3/make/g++
# are here so the build still succeeds where it has to compile from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# The database lives on a mounted volume. Without one, every deploy starts empty.
ENV DATABASE_PATH=/data/periphery.db
ENV NODE_ENV=production
ENV PORT=3000
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
