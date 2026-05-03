# syntax=docker/dockerfile:1
ARG PYTHON_VERSION=3.11

# Stage 1: install Python ML dependencies (aarch64 glibc wheels available)
FROM python:${PYTHON_VERSION}-slim AS python-deps

RUN pip install --no-cache-dir ai-edge-litert numpy

# Stage 2: Node runtime + Python runtime
FROM node:22-slim

ARG PYTHON_VERSION=3.11

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 make g++ sox libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*

COPY --from=python-deps /usr/local/lib/python${PYTHON_VERSION}/site-packages /usr/lib/python3/dist-packages

WORKDIR /app/backend
COPY . .
RUN npm install

EXPOSE 5100

CMD ["npm", "start"]
