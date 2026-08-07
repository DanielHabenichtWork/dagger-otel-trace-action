#!/usr/bin/env node
// Summarize captured Dagger telemetry into a compact, agent-friendly text
// report: the slowest steps (what's taking long), the failing steps with their
// line-numbered log tail (what broke and where), and the span tree for context.
// Reads the collector's raw traces.jsonl / logs.jsonl.
//
// usage: summarize.mjs <data-dir> [--title T] [--top N] [--max-log-lines N] [--cached]
//        summarize.mjs <data-dir> --grep STEP [--all] [--full]   # drill into a step
//
// The span decoding (dag.call -> readable label), tree building, and TUI-style
// visibility rules mirror scripts/viewer.html so the text matches the HTML.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let dataDir = null;
let title = "dagger trace";
let showCached = false;
let maxLogLines = 40;
let topN = 8;
let grep = null;
let showAll = false;
let full = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--title") title = args[++i];
  else if (a === "--cached") showCached = true;
  else if (a === "--max-log-lines") maxLogLines = Number(args[++i]);
  else if (a === "--top") topN = Number(args[++i]);
  else if (a === "--grep") grep = args[++i];
  else if (a === "--all") showAll = true;
  else if (a === "--full") full = true;
  else if (!dataDir) dataDir = a;
}
if (!dataDir) {
  console.error(
    "usage: summarize.mjs <data-dir> [--title T] [--grep STEP] [--all] [--full] [--cached] [--top N] [--max-log-lines N]",
  );
  process.exit(2);
}

function parseJsonl(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t));
  }
  return out;
}

/* ---------- OTLP attribute + dag.call decoding (ported from viewer.html) ---------- */
function attrVal(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("boolValue" in v) return v.boolValue;
  if ("doubleValue" in v) return v.doubleValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(attrVal);
  if ("kvlistValue" in v)
    return Object.fromEntries(
      (v.kvlistValue.values || []).map((kv) => [kv.key, attrVal(kv.value)]),
    );
  return v;
}
const attrsToObj = (list) => Object.fromEntries((list || []).map((a) => [a.key, attrVal(a.value)]));

const TDEC = new TextDecoder();
function b64ToBytes(s) {
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function pbScan(bytes) {
  const out = [];
  let i = 0;
  const varint = () => {
    let r = 0;
    let s = 0;
    let b;
    do {
      b = bytes[i++];
      r += (b & 0x7f) * 2 ** s;
      s += 7;
    } while (b & 0x80);
    return r;
  };
  while (i < bytes.length) {
    const tag = varint();
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) out.push({ field, wire, data: varint() });
    else if (wire === 2) {
      const len = varint();
      out.push({ field, wire, data: bytes.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      i += 4;
      out.push({ field, wire, data: null });
    } else if (wire === 1) {
      i += 8;
      out.push({ field, wire, data: null });
    } else break;
  }
  return out;
}
const pbStr = (u8) => TDEC.decode(u8);
function decodeLiteral(bytes) {
  for (const f of pbScan(bytes)) {
    switch (f.field) {
      case 7:
        return pbStr(f.data);
      case 8:
        return decodeList(f.data);
      case 3:
        return f.data !== 0;
      case 5:
        return f.data;
      case 4:
        return pbStr(f.data);
      case 1:
        return pbStr(f.data);
      case 10:
        return pbStr(f.data);
      case 9:
        return "{…}";
    }
  }
  return null;
}
function decodeList(bytes) {
  const out = [];
  for (const f of pbScan(bytes)) if (f.field === 1 && f.wire === 2) out.push(decodeLiteral(f.data));
  return out;
}
function decodeDagCall(b64) {
  let op = null;
  const args = [];
  try {
    for (const f of pbScan(b64ToBytes(b64))) {
      if (f.field === 3 && f.wire === 2) op = pbStr(f.data);
      else if (f.field === 4 && f.wire === 2) {
        let name = null;
        let value;
        for (const a of pbScan(f.data)) {
          if (a.field === 1 && a.wire === 2) name = pbStr(a.data);
          else if (a.field === 2 && a.wire === 2) value = decodeLiteral(a.data);
        }
        args.push({ name, value });
      }
    }
  } catch {
    return null;
  }
  return op ? { op, args } : null;
}
const litText = (v) => (v == null ? "" : Array.isArray(v) ? v.map(litText).join(" ") : String(v));
function callLabel(call, fallback) {
  if (!call) return fallback;
  const { op, args } = call;
  const by = {};
  for (const a of args) by[a.name] = a.value;
  const one = (s) => s.replace(/\s+/g, " ").trim();
  switch (op) {
    case "withExec":
      return one(`exec ${litText(by.args)}`);
    case "withEntrypoint":
      return one(`entrypoint ${litText(by.args)}`);
    case "from":
      return `from ${litText(by.address)}`;
    case "withWorkdir":
      return `workdir ${litText(by.path)}`;
    case "withEnvVariable":
      return one(`env ${litText(by.name)}=${litText(by.value)}`);
    case "withSecretVariable":
      return `secret-env ${litText(by.name)}`;
    case "withExposedPort":
      return `expose ${litText(by.port)}`;
    case "withMountedDirectory":
      return `mount-dir ${litText(by.path)}`;
    case "withMountedFile":
      return `mount-file ${litText(by.path)}`;
    case "withMountedCache":
      return `mount-cache ${litText(by.path)}`;
    case "withFile":
      return `file ${litText(by.path)}`;
    case "withNewFile":
      return `new-file ${litText(by.path)}`;
    case "withDirectory":
      return `with-dir ${litText(by.path)}`;
    case "directory":
      return `directory ${litText(by.path)}`;
    case "file":
      return `file ${litText(by.path)}`;
  }
  const scalars = args
    .filter((a) => a.value != null && !Array.isArray(a.value))
    .map((a) => litText(a.value))
    .filter((v) => v && !v.startsWith("xxh3:"));
  return one(op + (scalars.length ? ` ${scalars.join(" ")}` : ""));
}

/* ---------- model ---------- */
const spans = new Map();
const logsBySpan = new Map();

for (const batch of parseJsonl(join(dataDir, "traces.jsonl"))) {
  for (const rs of batch.resourceSpans || []) {
    const service = attrsToObj(rs.resource?.attributes)["service.name"] || "";
    for (const ss of rs.scopeSpans || []) {
      const scope = ss.scope?.name || "";
      // Infrastructure scopes: engine bootstrap and low-level HTTP/grpc/docker/
      // registry instrumentation. The user's pipeline lives in dagger.io/core |
      // cli | dagql. Treat infra like internal — hidden unless it's on the path
      // to a failure (so a failed engine start still shows) or --all is set.
      const infra = scope.startsWith("go.opentelemetry.io/") || scope === "dagger.io/engine.client";
      for (const s of ss.spans || []) {
        const attrs = attrsToObj(s.attributes);
        const call = attrs["dagger.io/dag.call"]
          ? decodeDagCall(attrs["dagger.io/dag.call"])
          : null;
        const span = {
          id: s.spanId,
          parent: s.parentSpanId || null,
          label: callLabel(call, s.name),
          service,
          scope,
          infra,
          start: Number(s.startTimeUnixNano) / 1e6,
          end: Number(s.endTimeUnixNano) / 1e6,
          statusCode: s.status?.code || 0,
          statusMsg: s.status?.message || "",
          cached: !!attrs["dagger.io/dag.cached"],
          internal: !!attrs["dagger.io/ui.internal"],
          passthrough: !!attrs["dagger.io/ui.passthrough"],
          encapsulate: !!attrs["dagger.io/ui.encapsulate"], // boundary: hide my subtree
          encapsulated: !!attrs["dagger.io/ui.encapsulated"], // hidden inside a boundary
          children: [],
        };
        const prev = spans.get(span.id);
        if (prev?.end && !span.end) continue; // keep the most complete record
        spans.set(span.id, span);
      }
    }
  }
}

for (const batch of parseJsonl(join(dataDir, "logs.jsonl"))) {
  for (const rl of batch.resourceLogs || []) {
    for (const sl of rl.scopeLogs || []) {
      for (const r of sl.logRecords || []) {
        if (!r.spanId) continue;
        const rec = {
          t: Number(r.timeUnixNano || r.observedTimeUnixNano),
          body: r.body?.stringValue || "",
        };
        if (!logsBySpan.has(r.spanId)) logsBySpan.set(r.spanId, []);
        logsBySpan.get(r.spanId).push(rec);
      }
    }
  }
}
for (const recs of logsBySpan.values()) recs.sort((a, b) => a.t - b.t);

// Per-exec resource-usage gauges (CPU/network/IO), keyed to a span by the
// dagger.io/metrics.span attribute. Gauges are cumulative totals for the exec,
// so across periodic re-exports we keep the largest (latest) value.
const metricsBySpan = new Map(); // spanId -> Map(name -> {value, unit})
for (const batch of parseJsonl(join(dataDir, "metrics.jsonl"))) {
  for (const rm of batch.resourceMetrics || []) {
    for (const sm of rm.scopeMetrics || []) {
      for (const m of sm.metrics || []) {
        const points = m.gauge?.dataPoints || m.sum?.dataPoints || [];
        for (const dp of points) {
          const a = attrsToObj(dp.attributes);
          const spanId = a["dagger.io/metrics.span"];
          if (!spanId) continue;
          const val = "asInt" in dp ? Number(dp.asInt) : "asDouble" in dp ? dp.asDouble : null;
          if (val == null || Number.isNaN(val)) continue;
          if (!metricsBySpan.has(spanId)) metricsBySpan.set(spanId, new Map());
          const mm = metricsBySpan.get(spanId);
          const prev = mm.get(m.name);
          if (!prev || val >= prev.value) mm.set(m.name, { value: val, unit: m.unit || "" });
        }
      }
    }
  }
}

let minStart = Number.POSITIVE_INFINITY;
let maxEnd = Number.NEGATIVE_INFINITY;
const roots = [];
for (const span of spans.values()) {
  const parent = span.parent && spans.get(span.parent);
  if (parent) parent.children.push(span);
  else roots.push(span);
  if (span.start) minStart = Math.min(minStart, span.start);
  if (span.end) maxEnd = Math.max(maxEnd, span.end);
}
const byStart = (a, b) => a.start - b.start;
for (const span of spans.values()) span.children.sort(byStart);
roots.sort(byStart);

// Does this span (or a descendant) carry a surfaced error? Errors inside
// internal / encapsulated subtrees are noise (e.g. registry 401s) unless the
// parent failed — matching the Dagger TUI. errVisible drives the errors list;
// subtreeErr reveals otherwise-hidden steps on the path to a failure.
const markErrors = (span, suppressed) => {
  span.errVisible = span.statusCode === 2 && !suppressed;
  let childErr = false;
  for (const c of span.children)
    childErr =
      markErrors(
        c,
        suppressed || c.internal || ((c.encapsulated || c.infra) && span.statusCode !== 2),
      ) || childErr;
  span.childErr = childErr; // a descendant surfaced an error
  span.subtreeErr = span.errVisible || childErr;
  return span.subtreeErr;
};
for (const r of roots) markErrors(r, r.internal);

// Visible forest, mirroring the Dagger TUI: hide internal spans; flatten
// passthrough into their children; `encapsulate` collapses a span's whole
// subtree (engine bootstrap, image resolution); `encapsulated` hides the span
// itself. Anything on the path to a failure is always revealed. `--all` shows
// everything, `--cached false` (default) drops cache hits.
function visibleChildren(list, parentFailed, encapCtx) {
  if (showAll) return list.slice().sort(byStart);
  const out = [];
  for (const c of list) {
    // Reveal a hidden span only when it lies on the path to a failure
    // (subtreeErr) — not merely because some ancestor failed, which would dump
    // every unrelated bootstrap/resolution subtree under a failed run.
    const reveal = c.subtreeErr;
    if ((c.internal || c.infra) && !reveal) continue;
    if ((c.encapsulated || encapCtx) && !reveal) continue;
    if (c.cached && !showCached) continue;
    const childCtx = encapCtx || c.encapsulate;
    if (c.passthrough)
      out.push(...visibleChildren(c.children, c.statusCode === 2 || parentFailed, childCtx));
    else {
      c._childCtx = childCtx;
      out.push(c);
    }
  }
  return out.sort(byStart);
}

/* ---------- render helpers ---------- */
const fmtDur = (ms) =>
  !Number.isFinite(ms) || ms < 0
    ? ""
    : ms < 1
      ? `${ms.toFixed(2)}ms`
      : ms < 1000
        ? `${ms.toFixed(1)}ms`
        : ms < 60000
          ? `${(ms / 1000).toFixed(2)}s`
          : `${Math.floor(ms / 60000)}m${((ms % 60000) / 1000).toFixed(0)}s`;
const fmtBytes = (n) => {
  if (!Number.isFinite(n)) return `${n}`;
  if (n < 1024) return `${n}B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < u.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${u[i]}`;
};
const fmtMicros = (us) => {
  const ms = us / 1000;
  if (ms < 1) return `${Math.round(us)}µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};
// Subtree resource totals for a span. Metrics live on leaf exec spans, so a
// subtree sum is meaningful and never double-counts. Returns null when nothing
// in the subtree reported usage.
function usageOf(span) {
  let cpu = 0;
  let netIn = 0;
  let netOut = 0;
  let any = false;
  const visit = (s) => {
    const mm = metricsBySpan.get(s.id);
    if (mm) {
      any = true;
      cpu += mm.get("dagger.io/metrics.cpustat.usage")?.value || 0;
      netIn += mm.get("dagger.io/metrics.netstat.rx.bytes")?.value || 0;
      netOut += mm.get("dagger.io/metrics.netstat.tx.bytes")?.value || 0;
    }
    for (const c of s.children) visit(c);
  };
  visit(span);
  return any ? { cpu, netIn, netOut } : null;
}
// A span's own resource usage (the exact exec the gauges were reported on),
// without rolling up descendants. Returns null when the span reported none.
function ownUsage(span) {
  const mm = metricsBySpan.get(span.id);
  if (!mm) return null;
  return {
    cpu: mm.get("dagger.io/metrics.cpustat.usage")?.value || 0,
    netIn: mm.get("dagger.io/metrics.netstat.rx.bytes")?.value || 0,
    netOut: mm.get("dagger.io/metrics.netstat.tx.bytes")?.value || 0,
  };
}
// Compact "CPU 91ms net ↓1.6KB ↑42KB" tag, or "" when there's no usage / no net.
const usageTag = (u) =>
  u
    ? `CPU ${fmtMicros(u.cpu)}${u.netIn || u.netOut ? ` net ↓${fmtBytes(u.netIn)} ↑${fmtBytes(u.netOut)}` : ""}`
    : "";
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const spanMatches = (s, q) => `${s.label} ${s.name}`.toLowerCase().includes(q);
function pathOf(span) {
  const parts = [];
  for (let p = span.parent && spans.get(span.parent); p; p = p.parent && spans.get(p.parent))
    parts.unshift(clip(p.label, 40));
  return parts.join(" › ");
}
// Line-numbered log tail for a span. cap<=0 means no truncation (show all).
function logLines(span, indent, cap) {
  const recs = logsBySpan.get(span.id) || [];
  if (!recs.length) return [];
  const all = stripAnsi(recs.map((r) => r.body).join(""))
    .replace(/\s+$/, "")
    .split("\n");
  const start = cap > 0 && all.length > cap ? all.length - cap : 0;
  const w = String(all.length).length;
  const o = [];
  if (start > 0)
    o.push(`${indent}… (${start} earlier line${start === 1 ? "" : "s"} omitted, --full for all)`);
  for (let i = start; i < all.length; i++)
    o.push(`${indent}${String(i + 1).padStart(w)}  ${all[i]}`);
  return o;
}
const logLen = (s) => (logsBySpan.get(s.id) || []).reduce((n, r) => n + r.body.length, 0);
function subtreeSpans(s, acc) {
  acc.push(s);
  for (const c of s.children) subtreeSpans(c, acc);
  return acc;
}
// The output for a failing step isn't always on the span that carries the error
// status. `dagger check` runs the function in a nested exec: the deep withExec
// errors, but the diff was printed by the `Ci.check` call span above it. Find
// the richest non-infra log within the failure's subtree, then fall back to the
// nearest log-bearing ancestor when nothing below it logged.
function outputSpan(span) {
  const below = subtreeSpans(span, []).filter((s) => !s.infra && logLen(s) > 0);
  if (below.length) return below.sort((a, b) => logLen(b) - logLen(a))[0];
  for (
    let cur = span.parent && spans.get(span.parent);
    cur;
    cur = cur.parent && spans.get(cur.parent)
  )
    if (!cur.infra && logLen(cur) > 0) return cur;
  return null;
}

const out = [];

/* ---------- drill-down: --grep a step, show its subtree + full logs ---------- */
if (grep) {
  const q = grep.toLowerCase();
  // Report the top-most match in each chain (a matching ancestor covers its
  // matching descendants), so drilling into a job doesn't repeat its steps.
  const matched = [...spans.values()]
    .filter((s) => {
      if (!spanMatches(s, q)) return false;
      for (let p = s.parent && spans.get(s.parent); p; p = p.parent && spans.get(p.parent))
        if (spanMatches(p, q)) return false;
      return true;
    })
    .sort(byStart);

  out.push(`# ${title} — filter: ${grep}`);
  out.push(
    `${matched.length} match${matched.length === 1 ? "" : "es"}${showAll ? " · showing all spans" : ""}`,
  );

  const cap = full ? 0 : maxLogLines;
  const drill = (span, depth) => {
    const flags = (span.statusCode === 2 ? " ERROR" : "") + (span.cached ? " cached" : "");
    out.push(
      `${"  ".repeat(depth)}${clip(span.label, 160)}  ${fmtDur(span.end - span.start)}${flags}`,
    );
    if (span.statusMsg)
      out.push(`${"  ".repeat(depth + 1)}status: ${clip(span.statusMsg.replace(/\s+$/, ""), 500)}`);
    out.push(...logLines(span, "  ".repeat(depth + 1), cap));
    for (const c of visibleChildren(span.children, span.statusCode === 2, span.encapsulate))
      drill(c, depth + 1);
  };
  for (const m of matched) {
    out.push("");
    const p = pathOf(m);
    if (p) out.push(`# path: ${p}`);
    drill(m, 0);
  }
  if (!matched.length) out.push("", "(no spans matched)");
  process.stdout.write(`${out.join("\n")}\n`);
  process.exit(0);
}

/* ---------- default overview: slowest + errors + tree ---------- */
const lines = [];
const visible = []; // visible tree steps, for the slowest-steps ranking
let shown = 0;
let cachedHidden = 0;
if (!showCached)
  for (const s of spans.values()) if (s.cached && !s.internal && !s.infra) cachedHidden++;
function walk(list, depth, parentFailed, encapCtx) {
  for (const c of visibleChildren(list, parentFailed, encapCtx)) {
    shown++;
    const dur = c.end - c.start;
    const flags = (c.errVisible ? " ERROR" : "") + (c.cached ? " cached" : "");
    const tag = usageTag(ownUsage(c));
    lines.push(
      `${"  ".repeat(depth)}${clip(c.label, 160)}  ${fmtDur(dur)}${flags}${tag ? `  [${tag}]` : ""}`,
    );
    visible.push({ span: c, depth, dur });
    walk(c.children, depth + 1, c.statusCode === 2 || parentFailed, c._childCtx);
  }
}
walk(roots, 0, false, false);

// Failing steps: the deepest error spans (a wrapper that only propagates its
// child's failure isn't itself interesting), deduped by the log-bearing span
// that holds their output. Collected across all spans, since the real failure
// can sit below the visible tree.
const errorEntries = [];
const seenLog = new Set();
for (const e of [...spans.values()].filter((s) => s.errVisible && !s.childErr).sort(byStart)) {
  const log = outputSpan(e);
  const key = log ? log.id : e.id;
  if (seenLog.has(key)) continue;
  seenLog.add(key);
  errorEntries.push({ e, log });
}

// Slowest steps by wall time — the "what's taking long" view. Roots (depth 0)
// are the invocation wrapper and just aggregate their children, so skip them;
// what's left are the meaningful steps (from, exec, …).
const slowest = visible
  .filter((v) => v.depth > 0 && v.dur >= 1 && !v.span.cached)
  .sort((a, b) => b.dur - a.dur)
  .slice(0, topN);

const totalDur = Number.isFinite(minStart) ? fmtDur(maxEnd - minStart) : "";
let runCpu = 0;
let runIn = 0;
let runOut = 0;
let runUsage = false;
for (const mm of metricsBySpan.values()) {
  runUsage = true;
  runCpu += mm.get("dagger.io/metrics.cpustat.usage")?.value || 0;
  runIn += mm.get("dagger.io/metrics.netstat.rx.bytes")?.value || 0;
  runOut += mm.get("dagger.io/metrics.netstat.tx.bytes")?.value || 0;
}
out.push(`# ${title}`);
out.push(
  `${shown} spans · ${errorEntries.length} error${errorEntries.length === 1 ? "" : "s"}${totalDur ? ` · ${totalDur}` : ""}${cachedHidden && !showCached ? ` · ${cachedHidden} cached hidden` : ""}${runUsage ? ` · CPU ${fmtMicros(runCpu)} · net ↓${fmtBytes(runIn)} ↑${fmtBytes(runOut)}` : ""}`,
);

if (slowest.length) {
  const w = Math.max(...slowest.map((v) => fmtDur(v.dur).length));
  out.push("", "## slowest");
  for (const v of slowest) {
    const tag = usageTag(usageOf(v.span));
    out.push(
      `${fmtDur(v.dur).padStart(w)}  ${clip(v.span.label, 160)}${v.span.errVisible ? "  ERROR" : ""}${tag ? `  [${tag}]` : ""}`,
    );
  }
}

if (errorEntries.length) {
  out.push("", "## errors");
  for (const { e, log } of errorEntries) {
    out.push("", `✖ ${clip(e.label, 200)}  (${fmtDur(e.end - e.start)})`);
    if (e.statusMsg) out.push(`  ${clip(e.statusMsg.replace(/\s+$/, ""), 500)}`);
    // The output often sits on an ancestor call span, not the errored exec.
    // Line numbers are absolute within that step's output, so a reported line
    // (e.g. the assertion that failed) can be located in the full log.
    if (log) {
      if (log !== e) out.push(`  ↳ output from ${clip(log.label, 120)}`);
      out.push(...logLines(log, "  ", full ? 0 : maxLogLines));
    }
  }
}

out.push("", "## tree");
out.push(...(lines.length ? lines : ["(no spans captured)"]));

process.stdout.write(`${out.join("\n")}\n`);
