#!/bin/zsh
set -euo pipefail

RUNTIME_DIR="/Users/jinlongchen/Library/Application Support/iPad Meeting Relay"
export MODELSCOPE_CACHE="$RUNTIME_DIR/diarization-models"
cd "$RUNTIME_DIR/diarization-sidecar"
exec "$RUNTIME_DIR/diarization-venv/bin/uvicorn" app:create_production_app \
  --factory \
  --host 127.0.0.1 \
  --port 8001 \
  --log-level warning
