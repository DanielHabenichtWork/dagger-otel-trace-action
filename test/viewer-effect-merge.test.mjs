// Guards the viewer's passthrough/effect span-model behavior for Dagger's
// lazily-built dagql calls. Two related concerns:
//
// 1. mergeEffectSpans. Dagger emits each call as TWO spans: the call span itself
//    (dag.pending, ~0 duration, but it carries the logs + decoded label) and a
//    separate "resume <op>" effect span that holds the real execution time. The
//    effect span is marked dagger.io/ui.passthrough and links back to the call
//    span it runs (a link with no dagger.io/link.purpose) plus the span(s) that
//    caused it (link.purpose="cause"). visibleChildren replaces passthrough
//    spans with their children, so a passthrough *leaf* effect span — with the
//    runtime on it — would silently vanish and the call span would read ~0ms.
//    mergeEffectSpans folds the effect span's interval + error status onto its
//    linked call span so nothing is lost.
//
// 2. Passthrough surfacing. A passthrough span whose interval is largely NOT
//    covered by any visible descendant (e.g. a long POST /query while the engine
//    builds a container) would otherwise leave an unexplained gap in the
//    waterfall. visibleChildren surfaces such a span as its own collapsible row
//    (>= PASSTHROUGH_MIN_MS of uncovered self-time); short wrappers and spans
//    already merged by mergeEffectSpans stay spliced/hidden.
//
// The viewer has no build step and no module exports, so we extract its pure
// model functions (attrVal … visibleChildren) straight out of the HTML and eval
// them — same approach CLAUDE.md documents for decoder testing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const viewer = readFileSync(join(here, "..", "scripts", "viewer.html"), "utf8");

// A fresh model instance (own `state`) per call, so tests don't share state.
function makeViewer() {
  const start = viewer.indexOf("function attrVal");
  const end = viewer.indexOf("function render()");
  assert.ok(start >= 0 && end > start, "could not locate model block in viewer.html");
  const block = viewer.slice(start, end);
  return new Function(
    `${block}\nreturn { state, ingestTraces, buildTree, visibleChildren };`,
  )();
}

// ---- OTLP-JSON fixture builders (the shape ingestTraces consumes) ----
const bool = (key, v) => ({ key, value: { boolValue: v } });
const str = (key, v) => ({ key, value: { stringValue: v } });
const ns = (ms) => String(ms * 1e6);

function span({ id, parent, name, start, end, attrs = [], links = [], err }) {
  return {
    spanId: id,
    parentSpanId: parent || undefined,
    traceId: "trace",
    name,
    startTimeUnixNano: ns(start),
    endTimeUnixNano: ns(end),
    status: err ? { code: 2, message: err } : {},
    attributes: attrs,
    links,
  };
}

const batch = (spans) => [
  {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [{ scope: { name: "dagger.io/dagql" }, spans }],
      },
    ],
  },
];

const PASSTHROUGH = bool("dagger.io/ui.passthrough", true);
const PENDING = bool("dagger.io/dag.pending", true);
const causeLink = (id) => ({ spanId: id, attributes: [str("dagger.io/link.purpose", "cause")] });
const effectLink = (id) => ({ spanId: id, attributes: [] });

const filters = { internal: false, encapsulated: false, cached: false };

// Flat list of every span the tree would render (passthrough splicing applied).
function visibleFlat(V) {
  const out = [];
  const walk = (parent) => {
    for (const c of V.visibleChildren(parent, filters, false)) {
      out.push(c);
      walk(c);
    }
  };
  walk(null);
  return out;
}

function load(spans) {
  const V = makeViewer();
  V.ingestTraces(batch(spans));
  V.buildTree();
  return V;
}

test("effect span's runtime folds onto its linked call span", () => {
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 500 }),
    span({ id: "call", parent: "root", name: "Container.withExec", start: 100, end: 100, attrs: [PENDING] }),
    span({
      id: "effect",
      parent: "root",
      name: "resume withExec",
      start: 110,
      end: 402,
      attrs: [PASSTHROUGH],
      links: [effectLink("call"), causeLink("root")],
    }),
  ]);
  const call = V.state.spans.get("call");
  // union of [100,100] and [110,402] → [100,402]
  assert.equal(call.start, 100);
  assert.equal(call.end, 402);
  assert.equal(call.end - call.start, 302, "call span must reflect the effect's runtime, not ~0ms");
});

test("the passthrough effect leaf is not rendered as its own row", () => {
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 500 }),
    span({ id: "call", parent: "root", name: "Container.withExec", start: 100, end: 100, attrs: [PENDING] }),
    span({
      id: "effect",
      parent: "root",
      name: "resume withExec",
      start: 110,
      end: 402,
      attrs: [PASSTHROUGH],
      links: [effectLink("call"), causeLink("root")],
    }),
  ]);
  const ids = visibleFlat(V).map((s) => s.id);
  assert.ok(ids.includes("call"), "call span should still render");
  assert.ok(!ids.includes("effect"), "passthrough effect leaf should be folded away, not shown");
});

test("an errored effect span propagates its error to the call span", () => {
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 500 }),
    span({ id: "call", parent: "root", name: "Container.withExec", start: 100, end: 100, attrs: [PENDING] }),
    span({
      id: "effect",
      parent: "root",
      name: "resume withExec",
      start: 110,
      end: 402,
      attrs: [PASSTHROUGH],
      links: [effectLink("call"), causeLink("root")],
      err: "exec failed: exit code 1",
    }),
  ]);
  const call = V.state.spans.get("call");
  assert.equal(call.statusCode, 2, "error on the dropped effect span must not be lost");
  assert.equal(call.statusMsg, "exec failed: exit code 1");
});

test("the non-cause link is chosen as the merge target", () => {
  // Two candidate links; only the one without link.purpose is the effect target.
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 500 }),
    span({ id: "call", parent: "root", name: "Container.withExec", start: 100, end: 100, attrs: [PENDING] }),
    span({ id: "cause", parent: "root", name: "POST /query", start: 5, end: 90 }),
    span({
      id: "effect",
      parent: "root",
      name: "resume withExec",
      start: 110,
      end: 402,
      attrs: [PASSTHROUGH],
      links: [causeLink("cause"), effectLink("call")],
    }),
  ]);
  assert.equal(V.state.spans.get("call").end, 402, "runtime should land on the effect (non-cause) link");
  assert.equal(V.state.spans.get("cause").end, 90, "the cause-link target must be left untouched");
});

test("a passthrough wrapper with children is left intact (children spliced, not merged away)", () => {
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 500 }),
    span({ id: "wrap", parent: "root", name: "POST /query", start: 50, end: 120, attrs: [PASSTHROUGH] }),
    span({ id: "grand", parent: "wrap", name: "Container.from", start: 60, end: 110 }),
  ]);
  const ids = visibleFlat(V).map((s) => s.id);
  assert.ok(!ids.includes("wrap"), "passthrough wrapper itself is not shown");
  assert.ok(ids.includes("grand"), "its child must still be spliced into the tree");
  assert.equal(V.state.spans.get("grand").end, 110, "wrapper splicing must not alter child timing");
});

test("a passthrough leaf without links is dropped without error", () => {
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 500 }),
    span({ id: "orphan", parent: "root", name: "POST /query", start: 50, end: 120, attrs: [PASSTHROUGH] }),
  ]);
  const ids = visibleFlat(V).map((s) => s.id);
  assert.ok(!ids.includes("orphan"), "a linkless passthrough leaf stays dropped (nothing to merge onto)");
});

// ---- passthrough surfacing (PASSTHROUGH_MIN_MS of uncovered self-time) ----

test("a passthrough span with large uncovered self-time is surfaced, child nested under it", () => {
  // A 1000ms POST /query whose only visible descendant (the exec) sits at its
  // tail — 990ms is uncovered, so the query should show as its own row.
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 1000 }),
    span({ id: "query", parent: "root", name: "POST /query", start: 0, end: 1000, attrs: [PASSTHROUGH] }),
    span({ id: "exec", parent: "query", name: "Container.withExec", start: 990, end: 1000, attrs: [PENDING] }),
  ]);
  const topIds = V.visibleChildren(null, filters, false).flatMap(function collect(s) {
    return [s.id, ...V.visibleChildren(s, filters, false).flatMap(collect)];
  });
  assert.ok(topIds.includes("query"), "the query span should be surfaced, not spliced away");
  const underRoot = V.visibleChildren(V.state.spans.get("root"), filters, false).map((s) => s.id);
  assert.deepEqual(underRoot, ["query"], "the exec must nest under the query, not be promoted to root");
  const underQuery = V.visibleChildren(V.state.spans.get("query"), filters, false).map((s) => s.id);
  assert.deepEqual(underQuery, ["exec"], "the surfaced query keeps its child");
});

test("a passthrough span fully covered by its child is still spliced away", () => {
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 1000 }),
    span({ id: "wrap", parent: "root", name: "POST /query", start: 0, end: 1000, attrs: [PASSTHROUGH] }),
    span({ id: "exec", parent: "wrap", name: "Container.withExec", start: 0, end: 1000 }),
  ]);
  const ids = visibleFlat(V).map((s) => s.id);
  assert.ok(!ids.includes("wrap"), "no uncovered self-time → wrapper stays spliced away");
  assert.ok(ids.includes("exec"), "the child is promoted");
});

test("a short passthrough span below the threshold is spliced away", () => {
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 1000 }),
    // 150ms < PASSTHROUGH_MIN_MS (200ms), childless
    span({ id: "blip", parent: "root", name: "POST /query", start: 0, end: 150, attrs: [PASSTHROUGH] }),
  ]);
  assert.ok(!visibleFlat(V).map((s) => s.id).includes("blip"), "sub-threshold passthrough noise stays hidden");
});

test("a long childless passthrough span is surfaced as a bare internal row", () => {
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 1000 }),
    span({ id: "slow", parent: "root", name: "POST /query", start: 0, end: 600, attrs: [PASSTHROUGH] }),
  ]);
  assert.ok(visibleFlat(V).map((s) => s.id).includes("slow"), "long internal time is surfaced even with no children");
});

test("a merged effect span is never surfaced, even when longer than the threshold", () => {
  // Effect span is 292ms (> threshold) but must stay folded onto its call span.
  const V = load([
    span({ id: "root", name: "run", start: 0, end: 500 }),
    span({ id: "call", parent: "root", name: "Container.withExec", start: 100, end: 100, attrs: [PENDING] }),
    span({
      id: "effect",
      parent: "root",
      name: "resume withExec",
      start: 110,
      end: 402,
      attrs: [PASSTHROUGH],
      links: [effectLink("call"), causeLink("root")],
    }),
  ]);
  const ids = visibleFlat(V).map((s) => s.id);
  assert.ok(!ids.includes("effect"), "merged effect span must not resurface via passthrough surfacing");
  assert.equal(V.state.spans.get("call").end - V.state.spans.get("call").start, 302, "its runtime lives on the call span");
});
