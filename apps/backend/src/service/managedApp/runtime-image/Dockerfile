FROM cherynyxus-backend:qq-information-20261015

USER root

# 清除继承自基础镜像的后端业务产物，仅保留纯净 Node 24 运行时与基础工具
RUN rm -rf /app /usr/local/bin/backend-entrypoint && mkdir -p /opt/chery-app-template /workspace /data && \
    chown 1000:1000 /workspace /data

WORKDIR /opt/chery-app-template

# 复制固定模板 package.json 并安装完整固定依赖树 (含 vite 等 devDependencies)
COPY template/package.json /opt/chery-app-template/package.json
RUN env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy -u NODE_ENV \
    /usr/bin/npm install --include=dev --registry=https://registry.npmmirror.com --no-audit --no-fund && \
    /usr/bin/npm cache clean --force

# 复制完整模板源码到 /opt/chery-app-template/skeleton 供离线初始化与参考
COPY template/ /opt/chery-app-template/skeleton/
RUN ln -s /opt/chery-app-template/node_modules /opt/chery-app-template/skeleton/node_modules && \
    chown -R root:root /opt/chery-app-template && \
    chmod -R a+rX,u+w,go-w /opt/chery-app-template

# 替换容器内的 npm / npx / pnpm / yarn 为受控离线拦截器，移除原始可联网 npm 入口
COPY bin/backup.mjs /opt/chery-app-template/backup.mjs
COPY bin/controlled-pkg.mjs /usr/local/bin/controlled-pkg.mjs
RUN chmod 755 /usr/local/bin/controlled-pkg.mjs && \
    rm -f /usr/bin/npm /usr/bin/npx /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn && \
    ln -s /usr/local/bin/controlled-pkg.mjs /usr/local/bin/npm && \
    ln -s /usr/local/bin/controlled-pkg.mjs /usr/local/bin/npx && \
    ln -s /usr/local/bin/controlled-pkg.mjs /usr/local/bin/pnpm && \
    ln -s /usr/local/bin/controlled-pkg.mjs /usr/local/bin/yarn && \
    ln -s /usr/local/bin/controlled-pkg.mjs /usr/bin/npm && \
    ln -s /usr/local/bin/controlled-pkg.mjs /usr/bin/npx

ENV NODE_ENV=production \
    NODE_PATH=/opt/chery-app-template/node_modules \
    HOME=/tmp \
    PORT=3000

WORKDIR /workspace
USER 1000:1000
ENTRYPOINT []
CMD ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 3600; done"]
