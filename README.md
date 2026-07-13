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
      - uses: dagger/dagger-for-github@v8
        with: { verb: check }

      # 3. Bundle + upload + (on PRs) comment. always() so a failed build still
      #    produces its trace.
      - uses: DanielHabenichtWork/dagger-otel-trace-action/finish@v1
        if: ${{ always() && steps.trace.outcome == 'success' }}
        continue-on-error: true
        with:
          title: "dagger check"
```

The `finish` step posts (and updates in place) a PR comment linking the trace.
Download it — it's a single `dagger-trace.html`, **not** a zip (uploaded with
`archive: false`) — and GitHub serves it `text/html` + `inline`, so it renders
directly in the browser.

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
start/action.yml    composite: run collector, export OTEL_* env
finish/action.yml   composite: stop collector, bundle HTML, upload, PR comment
scripts/            start.sh, finish.sh, bundle.sh,
                    collector-config.yaml, viewer.html
```

The viewer is hand-written vanilla HTML/JS — no build step, no dependencies.
