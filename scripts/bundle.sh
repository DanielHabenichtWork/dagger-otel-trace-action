#!/usr/bin/env bash
# Bundle captured OTLP data into a self-contained trace-viewer HTML file.
#
# usage: bundle.sh <data-dir> <out.html> [meta.json]
#   <data-dir>  directory containing traces.jsonl / logs.jsonl (collector file exporter)
#   <out.html>  output path for the single-file viewer
#   [meta.json] optional run metadata shown in the viewer header:
#               {"title":..,"repo":..,"ref":..,"sha":..,"date":..,"runUrl":..}
set -euo pipefail

data_dir=$1
out=$2
meta=${3:-}
template="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/viewer.html"
marker='<!--__DAGGER_TRACE_DATA__-->'

if [[ ! -s "$data_dir/traces.jsonl" ]]; then
  echo "error: $data_dir/traces.jsonl is missing or empty (did the collector run?)" >&2
  exit 1
fi

# base64 output never contains '<', so it is safe inside a <script> element
embed() { # embed <id> <file>
  printf '<script type="text/plain" id="%s">\n' "$1"
  gzip -c -9 "$2" | base64
  printf '</script>\n'
}

{
  sed -n "1,/^$marker\$/p" "$template" | sed '$d'
  if [[ -n "$meta" && -s "$meta" ]]; then
    printf '<script type="application/json" id="data-meta">'
    # JSON containing '</script' would end the element early; \u-escape '<'
    sed 's/</\\u003c/g' "$meta"
    printf '</script>\n'
  fi
  embed data-traces "$data_dir/traces.jsonl"
  if [[ -s "$data_dir/logs.jsonl" ]]; then
    embed data-logs "$data_dir/logs.jsonl"
  fi
  sed -n "/^$marker\$/,\$p" "$template" | sed '1d'
} > "$out"

echo "wrote $out ($(du -h "$out" | cut -f1 | tr -d ' '))" >&2
