# dagger-otel-trace-action

Capture [Dagger](https://dagger.io)'s OpenTelemetry stream in CI **without
Dagger Cloud**, and turn it into a single self-contained HTML trace viewer —
span waterfall, per-step stdout/stderr (ANSI-colored), error highlighting — that
you open straight in the browser.

Dagger emits OTLP for every run: each operation is a span, and each exec's
stdout/stderr is shipped as span-linked log records. This action runs an
[otel-collector-contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib)
sidecar on the runner to capture that stream to files, then bundles it into one
HTML file uploaded as a workflow artifact.

Nothing is sent to any external service — the collector and the bundle stay on
the runner, and the artifact is served behind your repo's normal access.

## Requirements

- A runner with **Docker** (the collector runs as a container).
- The `dagger` CLI available in the same job (e.g. via
  [`dagger/dagger-for-github`](https://github.com/dagger/dagger-for-github)).
  Dagger relays engine telemetry through the CLI, so it picks up the exported
  `OTEL_EXPORTER_OTLP_*` variables automatically.

## Usage

```yaml
permissions:
  contents: read
  pull-requests: write   # only if you want the PR comment

jobs:
  ci:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4

      # 1. Start the collector BEFORE any dagger step. Exports OTEL_* into the
      #    job env so dagger sends its telemetry here.
      - uses: DanielHabenichtWork/dagger-otel-trace-action/start@v1
        id: trace
        continue-on-error: true      # telemetry must never fail the build

      # 2. Run dagger however you like — the env is already set.
      - uses: dagger/dagger-for-github@v8.4.1
        with: { verb: check }

      # 3. Bundle + upload + (on PRs) comment. always() so a failed build still
      #    produces its trace.
      - uses: DanielHabenichtWork/dagger-otel-trace-action/finish@v1
        if: ${{ always() && steps.trace.outcome == 'success' }}
        continue-on-error: true
        with:
          title: "dagger check"
```

The `finish` step links the trace two ways: on the run's **job summary** page
(every run) and, on pull requests, in a PR comment it updates in place. The
link opens the trace straight in your browser — the artifact is a single
uncompressed HTML (`archive: false`) that GitHub serves `text/html` + `inline`,
so there's no download or unzip step.

**For agents / triage**, `finish` also embeds the compact text summary (the
same one the local `--format agent` prints — what's slow, what failed with
line-numbered logs, the span tree) inline in the job summary and PR comment,
behind a `<details>` so humans still see just the link. So an agent reviewing a
PR or a failed run gets the triage view with no download and no HTML to parse.
It additionally uploads a second `<artifact-name>-raw` artifact holding the raw
collector capture (`traces.jsonl` / `logs.jsonl`) plus the summary. The inline
`<details>` **links that raw artifact and shows the exact commands to drill in**
— no run id to look up:

```sh
gh run download <run-id> -n <artifact-name>-raw -D dagger-trace
npx dagger-trace report --grep '<step>' --full dagger-trace
```

So an agent that wants more than the summary can pull the raw traces/logs and
re-analyze any step offline, straight from the links in front of it.

The summary link lands where the event can carry it: on **`pull_request`** runs
it's upserted into a PR comment (unless `comment: false`) *and* the job summary;
on **`push`** and other events there's no PR to comment on, so it's on the run's
**Summary** page only. Rendering the summary needs Node — GitHub-hosted runners
have it; on a **self-hosted runner without Node** `finish` falls back to a Node
container (Docker is already required for the collector), so the agent summary
still appears. With no Node *and* no Docker it's skipped (the link still works).

## Local CLI

`dagger-trace` wraps a dagger command on your machine and produces the **same**
self-contained viewer you get in CI — start collector, run the command, bundle,
open. It's the same `scripts/` under the hood, so local and CI traces are
identical.

### Install

```sh
# global install from npm
npm install -g dagger-trace

# ...or straight from the repo
npm install -g DanielHabenichtWork/dagger-otel-trace-action

# ...or run without installing
npx dagger-trace call test
```

Both install the `dagger-trace` command. Or just run `./dagger-trace` from a
checkout — it's a self-contained bash script with no runtime dependencies
(Node is only the installer). macOS and Linux; on Windows use WSL or Git Bash.

### Use

```sh
# wrap `dagger <args>` — the bare form prepends `dagger` for you
./dagger-trace call test

# serve over HTTP (and open) instead of opening the file directly
./dagger-trace --serve call build --platform=linux/amd64

# wrap any command (not just dagger) after `--`
./dagger-trace -- make ci

# compact text summary instead of the HTML — for agents / the terminal
./dagger-trace --format agent call test
```

By default the format is `auto`: when stdout isn't a terminal (an agent or
script captured it) — or `CI`/`CLAUDECODE`/`AGENT` is set — it prints the agent
summary; an interactive human gets the HTML viewer. So an agent just runs
`dagger-trace call test` and gets the text without knowing the flag. Pass an
explicit `--format` to override the detection.

Like CI's `always()`, the trace is produced even when the command fails, and
the command's exit code is preserved. Same requirements as the actions: Docker
(for the collector) and the `dagger` CLI on your `PATH`.

| option | default | description |
|---|---|---|
| `--format FMT` | `auto` | `auto`, `html`, `agent`, or `both` (see below) |
| `--data-dir DIR` | fresh `mktemp` dir | where the collector writes |
| `--out FILE` | `dagger-trace.html` in the data-dir | viewer HTML path |
| `--title TITLE` | the command line | header shown in the viewer |
| `--serve [PORT]` | off (port `8000`) | serve over HTTP + open, instead of opening the file |
| `--no-open` | — | build the HTML but don't open a browser |

### Output formats

- **`auto`** (default) — `agent` when the caller looks like an agent or script
  (stdout isn't a terminal, or `CI`/`CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`/`AGENT`
  is set, or `TERM=dumb`), `html` otherwise. Falls back to `html` if `node`
  isn't on `PATH`. An explicit `--format` skips detection entirely.
- **`html`** — the self-contained viewer, opened in your browser.
- **`agent`** — a compact text summary printed to **stdout**, built for an LLM
  triaging a run (see below). Needs `node` on `PATH`.
- **`both`** — write the HTML *and* print the summary.

Options must come before the wrapped command; anything after the first
non-option token (or an explicit `--`) is passed through untouched, so
`dagger-trace call --foo` forwards `--foo` to dagger.

### The agent format

It answers the two questions you actually have about a run — **what's slow** and
**what failed** — without the 36 KB HTML blob:

- a one-line header (`N spans · E errors · duration`);
- **`## slowest`** — the steps that took longest, so you can spot the
  bottleneck even when nothing failed;
- **`## errors`** — each failing step with its status and a **line-numbered**
  log tail (line numbers are absolute in the step's output, so a reported
  failure line can be located in the full log);
- **`## tree`** — the span structure with durations.

It mirrors the Dagger TUI's visibility: engine bootstrap, image resolution, and
low-level HTTP/gRPC spans are hidden (revealed only on the path to a failure, or
with `--all`); ANSI is stripped; per-step logs are capped (`--max-log-lines`,
default 40; `--full` for everything).

```text
# dagger call test
6 spans · 1 error · 4.30s · 1 cached hidden

## slowest
2.28s  from alpine:3.20
1.06s  exec go build ./...
3.10s  exec go test ./...  ERROR

## errors

✖ exec go test ./...  (3.10s)
  process go test did not complete successfully: exit code 1
  1  --- FAIL: TestFoo (0.01s)
  2      foo_test.go:12: expected 3, got 4
  3  FAIL	example.com/pkg	3.10s

## tree
dagger call test  4.30s
  from alpine:3.20  2.28s
  exec go build ./...  1.06s
  exec go test ./...  3.10s ERROR
```

### Drilling into a step

The capture is kept on disk, and the agent run prints where (`» capture: …`).
Re-analyze it — zoom into one step and dump its full logs + sub-steps — without
re-running anything:

```sh
dagger-trace report --grep "go test" --full /tmp/dagger-otel.XXXX
```

`report` takes: `--grep STEP` (focus on matching steps, print their subtree +
logs), `--all` (include the normally-hidden infra spans), `--full` (don't
truncate logs), plus `--top`, `--max-log-lines`, `--title`, `--cached`.

### This repo's own CI (`.dagger/`)

The repo dogfoods everything: the root `dagger.json` + `.dagger/` source is a
Dagger (TypeScript SDK) module whose `check` function runs Biome formatting +
lint over the repo's own JS/JSON (scoped by `biome.json`). It's annotated as a
Dagger **check**, so it runs via `dagger check`; `.github/workflows/ci.yml`
runs it wrapped in the `start`/`finish` trace actions. Run the same pipeline
locally:

```sh
# the CI gate — Biome check over the repo (green when everything's formatted)
dagger check

# apply the fixes to your working tree
dagger call format export --path=.
```

Because it's a real pipeline, it doubles as the trace sample — just prefix
`dagger-trace`:

```sh
dagger-trace check                 # capture + open the HTML viewer
dagger-trace --format agent check  # ...or print what the agent sees
```

```text
# dagger check
14 spans · 0 errors · 5.12s · 35 cached hidden

## slowest
4.76s  ci:check
2.66s  check
1.03s  from node:22-alpine

## tree
dagger check  5.12s
  run  4.76s
    ci:check  4.76s
      check  2.66s
        from node:22-alpine  1.03s
        exec npx --yes @biomejs/biome@1.9.4 check .  0.09ms
```

Introduce a formatting slip (`echo 'const x=1' >> scripts/x.mjs`) and re-run to
see the failing view — the `## errors` section with Biome's line-numbered diff —
then drill in with `dagger-trace report --grep biome --full <capture-dir>`.

## Inputs

### `start`

| input | default | description |
|---|---|---|
| `data-dir` | `$RUNNER_TEMP/dagger-otel` | where the collector writes; must match `finish` |
| `collector-image` | pinned contrib image | override the collector image |

### `finish`

| input | default | description |
|---|---|---|
| `data-dir` | `$RUNNER_TEMP/dagger-otel` | must match `start` |
| `title` | `dagger trace` | header shown in the viewer |
| `artifact-name` | `dagger-trace.html` | artifact + downloaded file name |
| `retention-days` | `14` | artifact retention |
| `comment` | `true` | upsert a PR comment (pull_request events only) |
| `github-token` | `${{ github.token }}` | token for the comment (needs `pull-requests: write`) |

**Output:** `finish` exposes `artifact-url`.

## Notes

- **Concurrency:** the collector binds a random host port and names its
  container per run+attempt, so multiple jobs can capture on one runner.
- **Logs need the explicit endpoint:** Dagger only ships the stdout/stderr log
  stream when `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set (the `start` action does
  this for you).
- **Standalone viewer:** open `scripts/viewer.html` directly and drag-and-drop
  raw collector `traces.jsonl` / `logs.jsonl` (or `.gz`) — parsed locally, never
  uploaded.

## Layout

```
dagger-trace        local CLI: wrap a dagger command, capture, bundle, open
package.json        npm manifest (installs the dagger-trace bin globally)
start/action.yml    composite: run collector, export OTEL_* env
finish/action.yml   composite: stop collector, bundle HTML, upload, PR comment
scripts/            start.sh, finish.sh, bundle.sh, summarize.mjs,
                    collector-config.yaml, viewer.html
dagger.json         Dagger module config (source: .dagger)
.dagger/            Dagger CI module: `check` (biome) / `format` over the repo
biome.json          Biome config (scopes the repo's JS/JSON)
.github/workflows/  ci.yml — runs `dagger check`, traced via start/finish
```

The viewer is hand-written vanilla HTML/JS — no build step, no dependencies.
