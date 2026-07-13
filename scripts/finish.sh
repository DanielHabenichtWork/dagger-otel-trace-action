#!/usr/bin/env bash
# Stop the capture collector (flushing its file exporter) and bundle the
# captured telemetry into a self-contained viewer HTML.
#
# usage: finish.sh <data-dir> <out.html> [meta.json] [container-name]
set -euo pipefail

data_dir=$1
out=$2
meta=${3:-}
name=${4:-dagger-otel-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}}
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if docker inspect "$name" >/dev/null 2>&1; then
  docker stop "$name" >/dev/null
  docker rm "$name" >/dev/null
else
  echo "warning: collector container '$name' not found (already cleaned up?)" >&2
fi

"$dir/bundle.sh" "$data_dir" "$out" "$meta"
