#!/usr/bin/env bash
# Start an OTLP collector container that captures Dagger telemetry to files.
#
# usage: start.sh <data-dir> [container-name]
#
# Prints `export OTEL_...` lines on stdout (for local use: eval "$(start.sh /tmp/otel)"),
# and appends the same variables to $GITHUB_ENV when running in GitHub Actions.
# Host ports are assigned randomly so concurrent jobs on one runner don't collide.
set -euo pipefail

data_dir=$1
name=${2:-dagger-otel-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}}
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Override with COLLECTOR_IMAGE if set (the action's collector-image input).
image="${COLLECTOR_IMAGE:-otel/opentelemetry-collector-contrib:0.156.0@sha256:125bdbeb7590cc1952c5b3430ecf14063568980c2c93d5b38676cc0446ed8108}"

mkdir -p "$data_dir"
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" \
  --user "$(id -u)" \
  -p 127.0.0.1::4318 \
  -v "$dir/collector-config.yaml":/etc/otelcol-contrib/config.yaml:ro \
  -v "$data_dir":/data \
  "$image" >/dev/null

port=$(docker port "$name" 4318/tcp | head -1 | sed 's/.*://')
endpoint="http://127.0.0.1:$port"

for _ in $(seq 1 50); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$endpoint" || true)
  [[ "$code" != "000" ]] && break
  sleep 0.2
done
if [[ "${code:-000}" == "000" ]]; then
  echo "error: collector did not become ready on $endpoint" >&2
  docker logs "$name" >&2 || true
  exit 1
fi
echo "collector '$name' listening on $endpoint, writing to $data_dir" >&2

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
