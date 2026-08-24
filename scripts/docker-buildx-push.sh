#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-xiaotong378/tfembyweb}"
VERSION="${VERSION:-0.6.0}"
BUILDER="${BUILDER:-}"

if [[ -n "$BUILDER" ]]; then
  if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
    docker buildx create --name "$BUILDER" --driver docker-container --use
  else
    docker buildx use "$BUILDER"
  fi
fi

docker buildx inspect --bootstrap >/dev/null

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg "APP_VERSION=$VERSION" \
  --tag "$IMAGE:latest" \
  --push \
  .
