ARG BASE_IMAGE=cherynyxus-backend:apps-close-final-2c2e203c
FROM ${BASE_IMAGE}
USER root
# No persistent Backend configuration, credentials or user tool-home is mounted.
RUN python3 -m venv /opt/qq-tools && /opt/qq-tools/bin/pip install --no-cache-dir --index-url https://pypi.tuna.tsinghua.edu.cn/simple yt-dlp==2026.8.19
ENV PATH=/opt/qq-tools/bin:/usr/local/bin:/usr/bin:/bin HOME=/tmp
USER 1000:1000
ENTRYPOINT ["/usr/bin/bash"]
