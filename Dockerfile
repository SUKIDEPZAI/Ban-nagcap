FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp để tìm + stream nhạc YouTube
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
CMD ["node", "src/index.js"]
