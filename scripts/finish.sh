#!/usr/bin/env bash
# Stop the OTLP receiver (flushing its file writes) and bundle the captured
# telemetry into a self-contained viewer HTML.
#
# usage: finish.sh <data-dir> <out.html> [meta.json]
set -euo pipefail

data_dir=$1
out=$2
meta=${3:-}
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The receiver appends synchronously, so files are already durable; SIGTERM
# just stops the process cleanly. (No Docker — nothing else to tear down.)
if [[ -f "$data_dir/receiver.json" ]]; then
  pid=$(grep -o '"pid":[0-9]*' "$data_dir/receiver.json" | grep -o '[0-9]*' | head -1)
  if [[ -n "${pid:-}" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  fi
else
  echo "warning: no receiver.json in $data_dir (receiver not started?)" >&2
fi

"$dir/bundle.sh" "$data_dir" "$out" "$meta"
