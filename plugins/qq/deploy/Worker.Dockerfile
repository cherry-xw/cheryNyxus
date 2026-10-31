ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
# No persistent Backend configuration, credentials or user tool-home is mounted.
RUN python3 -m venv /opt/qq-tools && /opt/qq-tools/bin/pip install --no-cache-dir --index-url https://pypi.tuna.tsinghua.edu.cn/simple yt-dlp==2026.8.19
COPY src/workerEntrypoint.py /opt/qq-worker/entrypoint.py
RUN chmod 0755 /opt/qq-worker && chmod 0444 /opt/qq-worker/entrypoint.py
ENV PATH=/opt/qq-tools/bin:/usr/local/bin:/usr/bin:/bin HOME=/tmp
USER 1000:1000
ENTRYPOINT ["/usr/bin/bash"]
