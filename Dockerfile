FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends calibre ca-certificates fonts-dejavu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY storage ./storage

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
