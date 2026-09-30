FROM node:22-bookworm-slim

# This image is built once during host provisioning. Skill containers run
# with --network=none and never install packages at execution time.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.base.txt /tmp/requirements.base.txt
RUN python3 -m venv /opt/pi-python \
    && /opt/pi-python/bin/pip install --no-cache-dir --disable-pip-version-check -r /tmp/requirements.base.txt \
    && rm -f /tmp/requirements.base.txt

ENV PATH="/opt/pi-python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
