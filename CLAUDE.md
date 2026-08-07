# CLAUDE.md — dagger-otel-trace-action

Working notes for picking up development on this repo. User-facing usage lives in
`README.md`; this file is the "how it works / how to change it safely" companion.

## What this is

A GitHub composite action, in two halves, that captures Dagger's OpenTelemetry
stream on the runner (no Dagger Cloud) and turns it into a single self-contained
HTML trace viewer uploaded as a workflow artifact.

- **`start/`** — launches the OTLP receiver (`scripts/otlp-receiver.mjs`) and
  exports `OTEL_EXPORTER_OTLP_*` into the job env; drop it *before* the dagger
  steps. **No Docker** — the receiver runs on the runner's own Node.
- **`finish/`** — stops the receiver, bundles the captured telemetry into one
  HTML file, uploads it non-zipped, and (on PRs) upserts a comment + writes a
  job-summary link; run it `if: always()` *after* the dagger steps.

Everything stays on the runner. Nothing is sent to an external service.

## Data flow

```
dagger step ──OTLP/protobuf──> otlp-receiver.mjs (Node) ──> <data-dir>/{traces,logs}.jsonl
                                                                  │
                                          bundle.sh: gzip + base64-embed into viewer.html
                                                                  │
                                              single self-contained dagger-trace.html
                                                                  │
                                    upload-artifact (archive:false) → job summary + PR comment
```

- **No Docker (v1.5+).** Capture was originally an `otel-collector-contrib`
  container; it's now `scripts/otlp-receiver.mjs`, a dependency-free Node HTTP
  server that decodes OTLP/protobuf into the *exact* OTLP-JSON the collector's
  file exporter wrote (so viewer/summarize are unchanged). In CI it's launched
  with the runner's own Node via `process.execPath` (see `start/action.yml`), so
  no Node-on-PATH or Docker is needed. Correctness is pinned by
  `test/otlp-receiver.test.mjs` against fixtures captured from the real
  collector — don't change the decode output shape without updating/rerunning it.
- The receiver binds a **random loopback port** (concurrent jobs on one runner
  don't collide, given distinct `data-dir`s) and writes `receiver.json`
  (`{port,pid}`); `finish` stops it by pid.
- Dagger only ships the **stdout/stderr log stream** when
  `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set explicitly — `start.sh` sets both the
  generic endpoint and the signal-specific logs endpoint. With only the generic
  one you get spans but no output. (Learned empirically; don't "simplify" it away.)
- **Pass-through to a pre-existing collector.** `start.sh` reads any OTLP
  endpoint already in the job env (`OTEL_EXPORTER_OTLP_ENDPOINT`, or the
  signal-specific `..._TRACES/LOGS_ENDPOINT`) *before* it overwrites those vars
  with our loopback receiver, resolves per-signal upstream URLs (OTLP spec rule:
  signal-specific verbatim, generic gets `/v1/<signal>`), and passes them +
  `OTEL_EXPORTER_OTLP_HEADERS` to the receiver as `FORWARD_{TRACES,LOGS}[_HEADERS]`.
  The receiver tees the **raw request bytes verbatim** (same content-type/encoding
  the SDK sent — no re-encode) to that upstream, best-effort: forward errors only
  hit stderr, never the local capture or the 200 owed to Dagger. Forwarding is
  HTTP/protobuf only; a `grpc` protocol upstream is skipped with a note (the
  receiver can't speak gRPC). Reading env still works because `start.sh` only
  appends our vars to `$GITHUB_ENV`, not this shell's env.
- `upload-artifact` runs with **`archive: false`** (v7+) so the artifact is the
  bare `.html`, served `text/html` + `inline` from GitHub's blob domain and thus
  rendered in-browser (no zip, no download step). Only one file may be uploaded
  in this mode.

## File map

| File | Role |
|---|---|
| `start/action.yml` | composite: resolve dirs, then a `github-script` step runs `scripts/start.sh` under the runner's Node (`process.execPath`) |
| `finish/action.yml` | composite: build `meta.json`, `scripts/finish.sh`, `upload-artifact`, `github-script` (summary + PR comment) |
| `scripts/otlp-receiver.mjs` | dependency-free Node OTLP/HTTP receiver: decode OTLP/protobuf → collector-shaped `{traces,logs}.jsonl`; also the capture "server" |
| `scripts/start.sh` | resolve any pre-existing OTLP endpoint into `FORWARD_*`; background the receiver (`${NODE:-node}`); print/export `OTEL_*`; readiness-poll on `receiver.json` |
| `scripts/finish.sh` | stop the receiver (SIGTERM by pid from `receiver.json`); call `bundle.sh` |
| `scripts/bundle.sh` | gzip+base64-embed `traces.jsonl`/`logs.jsonl`/`meta.json` into `viewer.html` at the `<!--__DAGGER_TRACE_DATA__-->` marker |
| `test/otlp-receiver.test.mjs` | `node:test` harness: receiver output == collector output, against `test/fixtures/` (run by `dagger check`'s `test`) |
| `scripts/viewer.html` | the entire viewer — **where almost all real work happens** |

Composite steps reference sibling scripts via `$GITHUB_ACTION_PATH/../scripts/`
(because each half is its own action dir). Keep that relative path working.

## The viewer (`scripts/viewer.html`)

Hand-written vanilla HTML/JS — **no build step, no dependencies, no npm**. Keep it
that way. Rough map (line numbers drift; grep for the names):

- **Data load** — `bundle.sh` injects `<script type="text/plain" id="data-traces|data-logs">`
  (gzip+base64) and `id="data-meta"` (JSON). The page gunzips them with the
  browser-native `DecompressionStream("gzip")`. It also accepts **drag-and-drop**
  of raw `.jsonl`/`.gz` (receiver or collector output) when opened standalone.
- **`attrVal` / `attrsToObj`** — OTLP attribute → JS value (handles every OTLP
  value type; don't regress that).
- **dag.call decoding** (`pbScan`, `decodeLiteral`, `decodeList`, `decodeDagCall`,
  `callLabel`) — Dagger names every span after the raw dagql field
  (`Container.withExec`, `from`, …). The real command/args are base64-encoded in
  the `dagger.io/dag.call` attribute (Dagger's `callpbv1.Call` protobuf). We
  decode it into a readable label (`exec terraform validate`, `from alpine:3.20`,
  `mount-dir /src`). **Verified protobuf field numbers** (grounded in captured
  telemetry, not the .proto):
  - `Call`: f3 = field name, f4 = repeated `Argument`
  - `Argument`: f1 = name, f2 = `Literal` value
  - `Literal`: f7 = string, f8 = list, f3 = bool, f5 = int, f4 = enum name,
    f1 = reference digest (`xxh3:…`), f10 = metadata blob, f9 = object
- **`ingestTraces`** — builds the span model. Each span carries `name` (raw
  dagql), `label` (decoded), `call` (decoded op+args), and `search` (label+name,
  lowercased). Use `label` for display, `search` for filtering.
- **`ingestLogs`** — log records keyed by span id; `t` is kept in **nanoseconds**
  (spans convert to ms; mind the unit when comparing).
- **`render` / `addRow`** — the span waterfall tree.
- **`select`** — the detail panel: Error, Output (with timing), Call (decoded
  op+args), and a Span table showing **every** attribute (long/base64 values
  collapse behind `<details>` — nothing is dropped).
- **Log timing gutter** (`renderLogsInto`, `splitLogLines`, `fmtElapsed`,
  `fmtGap`) — per logical line: elapsed-since-task-start (`+1.2s`/`+1m03s`) and a
  gap chip (`▲Ns`) shown only when a line follows a pause ≥ `GAP_MIN_MS` (1s), so
  fast output stays quiet and stalls stand out. Records are re-split into logical
  lines because one record may hold several newlines or a partial line continued
  by the next record. Toggled by the `timing` checkbox.
- **`ansiToHtml`** — renders ANSI color escapes from tool output.

## Develop & verify locally

The scripts work outside CI. Capture a real trace from any Dagger module, then
bundle and eyeball it:

```bash
# 1. capture (needs node + the dagger CLI; no Docker)
eval "$(scripts/start.sh /tmp/otel)"
dagger check           # or any dagger call, in a repo with a module
scripts/finish.sh /tmp/otel /tmp/trace.html   # stops the receiver + bundles

# 2. open /tmp/trace.html in a browser
```

Fast iteration on the viewer without re-capturing — re-bundle an existing capture:

```bash
scripts/bundle.sh /tmp/otel /tmp/trace.html
```

Checks worth running after editing `viewer.html`:

- **Syntax** — extract each inline `<script>` and `new Function(src)` it, or just
  load the bundle in a browser and watch the console.
- **Decoder correctness** — the decoder functions are pure; you can extract the
  block between the dag.call marker comment and the model marker and run it in
  Node against a real `traces.jsonl` to confirm labels decode (100% of spans with
  a `dag.call` should decode).
- **Headless render** — `"Google Chrome" --headless=new --dump-dom
  --virtual-time-budget=5000 file:///tmp/trace.html` renders after JS runs; grep
  the dumped DOM for expected labels and scan stderr for JS errors. To exercise
  the detail panel/log gutter (which need a click), inject a small auto-click
  script before `</body>` in a temp copy, then `--dump-dom`.

## Release / versioning convention

- **SemVer annotated tags** (`vMAJOR.MINOR.PATCH`) plus a **moving `v1`** major
  alias. Released tags are treated as **immutable** — never re-point `v1.2.0`;
  cut a new tag and move `v1` to it.
- Consumers **SHA-pin** `…/start@<sha>` and `…/finish@<sha>` with a `# vX.Y.Z`
  comment. When you release, the consumer bump is: new SHA + updated comment.
- Ship: commit → `git tag -a vX.Y.Z` → `git tag -f v1 vX.Y.Z` →
  `git push origin HEAD:main <tag>` → `git push -f origin v1`.
- The consumer pins to the **commit** SHA (`git rev-parse vX.Y.Z^{commit}`), not
  the annotated-tag object SHA.

## Hard constraints

- **Public repo, no secrets, no private identifiers.** GitHub can't reference a
  private action across orgs, so this stays public. Before every release, scan
  changed files for organization names, internal hostnames, subscription/tenant
  IDs, tokens, local absolute paths — none belong here. Trace *data* only ever
  lands in the consuming repo's artifacts, never here.
- **Commit author** is a GitHub noreply address, not a personal/corporate email.
- **No dependencies in the viewer** — vanilla JS only.
- Trace/telemetry steps must **never fail the build** — the action is used with
  `continue-on-error: true` and the finish step gated on the receiver having
  started.
- **No dependencies anywhere** — the receiver, summarizer, and viewer are all
  vanilla Node/JS with zero npm deps; keep it that way.

## Known limitation (not a bug here)

Terraform ≤ 1.15 / hashicorp/terraform images ignore the injected `TRACEPARENT`,
so terraform's *own* OTLP spans appear as separate top-level roots instead of
nesting under the Dagger exec span. This is terraform-side. It folds in with
Terraform 1.16+ or OpenTofu ≥ 1.10 (both read `TRACEPARENT`) — no viewer change
needed.
