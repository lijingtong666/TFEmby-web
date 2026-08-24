#!/bin/sh
set -eu

python3 /app/tgbot/app.py &
BOT_PID=$!

node /app/dist/server/index.js &
WEB_PID=$!

shutdown() {
  trap - INT TERM
  kill "$WEB_PID" "$BOT_PID" 2>/dev/null || true
  wait "$WEB_PID" "$BOT_PID" 2>/dev/null || true
}

trap 'shutdown; exit 0' INT TERM

while kill -0 "$WEB_PID" 2>/dev/null && kill -0 "$BOT_PID" 2>/dev/null; do
  sleep 2
done

shutdown
exit 1
