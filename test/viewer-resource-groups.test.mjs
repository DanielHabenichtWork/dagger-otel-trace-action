import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const viewer = readFileSync(join(here, "..", "scripts", "viewer.html"), "utf8");
const start = viewer.indexOf("const METRIC_GROUPS =");
const end = viewer.indexOf("const fmtBytes", start);
assert.ok(start >= 0 && end > start, "could not locate metric-grouping block in viewer.html");
const metricGroup = new Function(`${viewer.slice(start, end)}\nreturn metricGroup;`)();

test("resource metrics are grouped under stable detail-panel subheaders", () => {
  assert.deepEqual(metricGroup("dagger.io/metrics.cpustat.usage"), {
    prefix: "dagger.io/metrics.cpustat.", label: "CPU", order: 10,
  });
  assert.deepEqual(metricGroup("dagger.io/metrics.iostat.pressure.some.total"), {
    prefix: "dagger.io/metrics.iostat.", label: "I/O", order: 20,
  });
  assert.deepEqual(metricGroup("dagger.io/metrics.netstat.rx.bytes"), {
    prefix: "dagger.io/metrics.netstat.", label: "Network", order: 30,
  });
  assert.deepEqual(metricGroup("custom.metric"), { label: "Other", order: 99 });
});
