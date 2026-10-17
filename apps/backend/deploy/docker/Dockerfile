FROM debian:trixie-slim

ENV PATH=/usr/local/bin:/usr/bin:/bin \
    NODE_ENV=production

WORKDIR /app

COPY apps/backend/deploy/docker/runtime/etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY apps/backend/deploy/docker/debian.sources /etc/apt/sources.list.d/debian.sources
RUN apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o APT::Update::Error-Mode=any update && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt install -y --no-install-recommends \
    ca-certificates curl wget git jq zip unzip xz-utils ripgrep file procps \
    openssh-client rsync iputils-ping dnsutils netcat-openbsd socat p7zip-full \
    tesseract-ocr tesseract-ocr-chi-sim imagemagick tzdata \
    python3 python-is-python3 python3-pip python3-venv python3-dev \
    build-essential bubblewrap npm util-linux \
    ffmpeg sqlite3 poppler-utils fonts-noto-cjk fonts-liberation \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2t64 libpango-1.0-0 libcairo2 libatspi2.0-0 libx11-6 libxcb1 \
    && npm install --global pnpm@10 \
    && apt-get clean


# prepare-runtime.sh supplies the pinned Node binary; OS tools are installed above.
COPY apps/backend/deploy/docker/runtime/supercronic /usr/local/bin/supercronic
COPY apps/backend/deploy/docker/runtime-supervisor.mjs /usr/local/bin/runtime-supervisor.mjs
COPY apps/backend/deploy/docker/crontab.mjs /usr/local/bin/crontab
COPY apps/backend/deploy/docker/runtime/node /usr/local/bin/node
COPY apps/backend/deploy/docker/runtime/N_m3u8DL-RE /usr/local/bin/N_m3u8DL-RE
COPY apps/backend/deploy/docker/runtime/etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY package.json pnpm-workspace.yaml /app/
COPY node_modules /app/node_modules
COPY apps/backend/dist /app/apps/backend/dist
COPY apps/backend/.chery.template /app/apps/backend/.chery.template
COPY apps/manager/server-dist /app/apps/manager/server-dist
COPY apps/manager/dist/ui /app/apps/manager/dist/ui
COPY plugins/qq/dist /app/opt/qq-plugin
COPY plugins/settings/dist /app/opt/settings-plugin
COPY apps/backend/deploy/docker/config.example.yaml /app/opt/backend.config.example.yaml
COPY apps/backend/deploy/docker/backend-entrypoint.sh /usr/local/bin/backend-entrypoint

RUN chmod 0755 /usr/local/bin/supercronic /usr/local/bin/crontab /usr/local/bin/node /usr/local/bin/N_m3u8DL-RE /usr/local/bin/backend-entrypoint \
    && mkdir -p /app/apps/backend/.chery/data \
       /app/apps/backend/.chery/qq-personal-memory \
       /app/apps/backend/.chery/ingress \
       /app/apps/backend/data \
    && chown -R 1000:1000 /app /usr/local/bin/node /usr/local/bin/backend-entrypoint

USER 1000:1000
ENTRYPOINT ["backend-entrypoint"]
