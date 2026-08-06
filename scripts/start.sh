#!/usr/bin/env bash
# Launch the dependency-free OTLP receiver (scripts/otlp-receiver.mjs) that
# captures Dagger's OpenTelemetry stream to <data-dir>/{traces,logs}.jsonl.
# No Docker — just Node. Prints `export OTEL_...` lines on stdout (for local
# use: eval "$(start.sh /tmp/otel)") and appends the same to $GITHUB_ENV in CI.
#
# usage: start.sh <data-dir>
#
# The receiver binds a random loopback port (concurrent jobs don't collide),
# writes {port,pid} to <data-dir>/receiver.json, and runs in the background;
# finish.sh stops it (by pid) to flush and bundle. Set NODE to override the
# node binary (CI passes the runner's own Node so no host install is needed).
set -euo pipefail

data_dir=$1
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node_bin=${NODE:-node}

mkdir -p "$data_dir"
rm -f "$data_dir/receiver.json"

# Detach fully so the receiver outlives this shell (and, in CI, this step).
nohup "$node_bin" "$dir/otlp-receiver.mjs" "$data_dir" >"$data_dir/receiver.log" 2>&1 &
disown 2>/dev/null || true

for _ in $(seq 1 100); do
  [[ -s "$data_dir/receiver.json" ]] && break
  sleep 0.1
done
port=$(grep -o '"port":[0-9]*' "$data_dir/receiver.json" 2>/dev/null | grep -o '[0-9]*' | head -1)
if [[ -z "${port:-}" ]]; then
  echo "error: OTLP receiver did not start" >&2
  cat "$data_dir/receiver.log" >&2 2>/dev/null || true
  exit 1
fi
endpoint="http://127.0.0.1:$port"
echo "OTLP receiver listening on $endpoint, writing to $data_dir" >&2

# Dagger only ships the log stream (per-exec stdout/stderr) when the
# logs endpoint is set explicitly, so set the signal-specific vars too.
vars=(
  "OTEL_EXPORTER_OTLP_ENDPOINT=$endpoint"
  "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf"
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=$endpoint/v1/logs"
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf"
)
for v in "${vars[@]}"; do
  echo "export $v"
  if [[ -n "${GITHUB_ENV:-}" ]]; then echo "$v" >> "$GITHUB_ENV"; fi
done
