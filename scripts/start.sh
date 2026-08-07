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

# Honour any OTLP endpoint the runner already exported: tee a copy of the
# captured telemetry there too. Resolve per-signal upstream URLs per the OTLP
# env-var spec — a signal-specific endpoint is used verbatim; the generic one
# gets /v1/<signal> appended. Read these now, before we point Dagger at our own
# loopback receiver below (we only mutate $GITHUB_ENV, not this shell's env, so
# the originals are still visible). The receiver forwards over HTTP/protobuf, so
# skip a gRPC upstream — it can't accept the bytes Dagger emits.
resolve_fwd() {
  local specific=$1 generic=$2 path=$3 proto=$4
  case "${proto:-}" in
    grpc | *grpc*)
      echo "note: OTLP protocol '$proto' is gRPC; not forwarding $path (receiver is HTTP/protobuf)" >&2
      return
      ;;
  esac
  if [[ -n "$specific" ]]; then
    echo "$specific"
  elif [[ -n "$generic" ]]; then
    echo "${generic%/}$path"
  fi
}
fwd_traces=$(resolve_fwd "${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-}" "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" /v1/traces \
  "${OTEL_EXPORTER_OTLP_TRACES_PROTOCOL:-${OTEL_EXPORTER_OTLP_PROTOCOL:-}}")
fwd_logs=$(resolve_fwd "${OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:-}" "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" /v1/logs \
  "${OTEL_EXPORTER_OTLP_LOGS_PROTOCOL:-${OTEL_EXPORTER_OTLP_PROTOCOL:-}}")
fwd_metrics=$(resolve_fwd "${OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:-}" "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" /v1/metrics \
  "${OTEL_EXPORTER_OTLP_METRICS_PROTOCOL:-${OTEL_EXPORTER_OTLP_PROTOCOL:-}}")
fwd_traces_headers="${OTEL_EXPORTER_OTLP_TRACES_HEADERS:-${OTEL_EXPORTER_OTLP_HEADERS:-}}"
fwd_logs_headers="${OTEL_EXPORTER_OTLP_LOGS_HEADERS:-${OTEL_EXPORTER_OTLP_HEADERS:-}}"
fwd_metrics_headers="${OTEL_EXPORTER_OTLP_METRICS_HEADERS:-${OTEL_EXPORTER_OTLP_HEADERS:-}}"
[[ -n "$fwd_traces" ]] && echo "forwarding a copy of traces to $fwd_traces" >&2
[[ -n "$fwd_logs" ]] && echo "forwarding a copy of logs to $fwd_logs" >&2
[[ -n "$fwd_metrics" ]] && echo "forwarding a copy of metrics to $fwd_metrics" >&2

# Detach fully so the receiver outlives this shell (and, in CI, this step).
FORWARD_TRACES="$fwd_traces" FORWARD_LOGS="$fwd_logs" FORWARD_METRICS="$fwd_metrics" \
  FORWARD_TRACES_HEADERS="$fwd_traces_headers" FORWARD_LOGS_HEADERS="$fwd_logs_headers" \
  FORWARD_METRICS_HEADERS="$fwd_metrics_headers" \
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

# Dagger only ships the log stream (per-exec stdout/stderr) and the engine's
# per-exec resource-usage metrics (CPU/network/IO) when those signal-specific
# endpoints are set explicitly, so set them alongside the generic one.
vars=(
  "OTEL_EXPORTER_OTLP_ENDPOINT=$endpoint"
  "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf"
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=$endpoint/v1/logs"
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/protobuf"
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=$endpoint/v1/metrics"
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/protobuf"
)
for v in "${vars[@]}"; do
  echo "export $v"
  if [[ -n "${GITHUB_ENV:-}" ]]; then echo "$v" >> "$GITHUB_ENV"; fi
done
