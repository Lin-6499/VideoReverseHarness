# syntax=docker/dockerfile:1
#
# The reason this image exists: ffmpeg is the harness's one hard dependency, and
# it is the most common cause of a failed first run. Baking it in removes that
# class of problem entirely -- mounting the project directory means the host
# still owns the code, while the container owns the media stack.

FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg: required for all video work.
# libgl1/libglib2.0-0: needed by opencv even in headless builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy packaging metadata first so dependency installation is cached across
# source edits -- this is the difference between a 20s and a 5min rebuild.
COPY pyproject.toml README.md ./
COPY src/ ./src/
COPY configs/ ./configs/

# The "media" extra brings in scenedetect + opencv, without which L2 falls back
# to uniform segmentation. Explicitly requested here because a container that
# silently degrades is worse than one that fails.
RUN pip install --no-cache-dir -e ".[media]"

# Non-root by default: the container writes to /work and /app/output only.
RUN useradd --create-home --uid 1000 vrh && mkdir -p /work /app/output \
    && chown -R vrh:vrh /app /work
USER vrh

WORKDIR /work

ENTRYPOINT ["vrh"]
CMD ["doctor"]
