import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const viewer = readFileSync(join(here, "..", "scripts", "viewer.html"), "utf8");
const start = viewer.indexOf('const CPU_USAGE =');
const end = viewer.indexOf('function gotoSpan');
assert.ok(start >= 0 && end > start, "could not locate usage-ranking block in viewer.html");
const usageBlock = viewer.slice(start, end);

const CPU = "dagger.io/metrics.cpustat.usage";
const RX = "dagger.io/metrics.netstat.rx.bytes";
const TX = "dagger.io/metrics.netstat.tx.bytes";
const metrics = (values) => new Map(Object.entries(values).map(([name, value]) => [name, { value }]));

function makeUsage(spans, metricsBySpan) {
  const state = {
    spans: new Map(spans.map((span) => [span.id, span])),
    metricsBySpan: new Map(Object.entries(metricsBySpan)),
  };
  return new Function("state", `${usageBlock}\nreturn { totalUsage, rankedUsage };`)(state);
}

test("CPU ranking orders metric-bearing spans and omits zero usage", () => {
  const U = makeUsage(
    [
      { id: "slow", label: "slow compile", start: 20 },
      { id: "fast", label: "fast setup", start: 10 },
      { id: "idle", label: "idle", start: 0 },
    ],
    {
      slow: metrics({ [CPU]: 9_000_000 }),
      fast: metrics({ [CPU]: 2_000_000 }),
      idle: metrics({ [CPU]: 0 }),
    },
  );

  assert.deepEqual(U.rankedUsage("cpu").map((row) => row.span.id), ["slow", "fast"]);
  assert.deepEqual(U.rankedUsage("cpu").map((row) => row.value), [9_000_000, 2_000_000]);
});

test("network ranking uses received plus transmitted bytes and retains the split", () => {
  const U = makeUsage(
    [
      { id: "download", label: "download", start: 0 },
      { id: "upload", label: "upload", start: 1 },
    ],
    {
      download: metrics({ [RX]: 800, [TX]: 100 }),
      upload: metrics({ [RX]: 50, [TX]: 1_000 }),
    },
  );

  const rows = U.rankedUsage("network");
  assert.deepEqual(rows.map((row) => row.span.id), ["upload", "download"]);
  assert.deepEqual(
    { value: rows[0].value, netIn: rows[0].netIn, netOut: rows[0].netOut },
    { value: 1_050, netIn: 50, netOut: 1_000 },
  );
  assert.deepEqual(U.totalUsage(), { cpu: 0, netIn: 850, netOut: 1_100 });
});

test("usage ranking respects its result limit", () => {
  const spans = Array.from({ length: 12 }, (_, i) => ({ id: `span-${i}`, label: `span ${i}`, start: i }));
  const metricsBySpan = Object.fromEntries(spans.map((span, i) => [span.id, metrics({ [CPU]: i + 1 })]));
  const U = makeUsage(spans, metricsBySpan);

  assert.equal(U.rankedUsage("cpu").length, 10);
  assert.deepEqual(U.rankedUsage("cpu", 2).map((row) => row.span.id), ["span-11", "span-10"]);
});
