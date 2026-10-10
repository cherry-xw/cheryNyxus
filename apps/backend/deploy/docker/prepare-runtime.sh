#!/bin/sh
# 为镜像运行时准备离线 Node 运行时包（Node 二进制 + CA 证书，均来自本机已安装组件）。
set -eu
cd "$(dirname "$0")"   # deployment runtime dependencies
mkdir -p runtime/etc/ssl/certs
cp "$(command -v node)" runtime/node
cp /etc/ssl/certs/ca-certificates.crt runtime/etc/ssl/certs/ca-certificates.crt
chmod 0755 runtime/node
node --version
