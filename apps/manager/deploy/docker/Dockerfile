FROM debian:trixie-slim
WORKDIR /app
COPY apps/backend/deploy/docker/runtime/node /usr/local/bin/node
COPY apps/backend/deploy/docker/runtime/etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY package.json /app/
COPY node_modules /app/node_modules
COPY apps/manager/server-dist /app/manager/server-dist
COPY apps/manager/dist/ui /app/manager/dist/ui
USER 1000:1000
ENTRYPOINT ["node", "manager/server-dist/index.js"]
