FROM debian:trixie-slim
WORKDIR /app
COPY apps/backend/deploy/docker/runtime/node /usr/local/bin/node
COPY dist/web /app/web
COPY apps/web/deploy/docker/web-server.mjs /app/web-server.mjs
USER 1000:1000
ENTRYPOINT ["node", "/app/web-server.mjs"]
