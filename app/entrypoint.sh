#!/bin/sh
# Goldsmiths Site & AI Builder - container entrypoint.
# Never runs as root. The image sets USER 1000:1000 and /data is created owned by
# 1000 in the image, so a named volume mounted there is writable straight away:
# no chown, no privilege drop, no su-exec.
set -eu

OLLAMA_URL="${OLLAMA_URL:-http://ollama:11434}"
MODEL="${MODEL:-qwen2.5-coder:7b}"

echo "waiting for the model service at ${OLLAMA_URL}"
i=0
until curl -fsS --max-time 3 "${OLLAMA_URL}/api/tags" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then
    echo "model service did not answer after 4 minutes; starting anyway so the page is reachable"
    break
  fi
  sleep 2
done

if curl -fsS --max-time 5 "${OLLAMA_URL}/api/tags" 2>/dev/null | grep -q "\"${MODEL%%:*}"; then
  echo "model ${MODEL} already present"
else
  echo "pulling ${MODEL} - this happens once, and it is a few gigabytes"
  curl -fsS -X POST "${OLLAMA_URL}/api/pull" -d "{\"name\":\"${MODEL}\"}" || \
    echo "model pull failed; the app will retry on the first build"
fi

# exec so node receives SIGTERM directly (review F3)
exec node server.js
