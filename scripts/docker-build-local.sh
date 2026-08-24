#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-xiaotong378/tfembyweb}"
VERSION="${VERSION:-local}"
ARCH="${ARCH:-$(uname -m)}"

case "$ARCH" in
  arm64|aarch64)
    PLATFORM="linux/arm64"
    SUFFIX="arm64"
    ;;
  x86_64|amd64)
    PLATFORM="linux/amd64"
    SUFFIX="amd64"
    ;;
  *)
    echo "Unsupported ARCH: $ARCH" >&2
    exit 1
    ;;
esac

docker buildx build \
  --platform "$PLATFORM" \
  --tag "$IMAGE:$VERSION-$SUFFIX" \
  --load \
  .
