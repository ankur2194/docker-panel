# Optional container image. Running directly on the host with Node is lighter (see README).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY --from=build /app/web/dist ./web/dist
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.js"]
