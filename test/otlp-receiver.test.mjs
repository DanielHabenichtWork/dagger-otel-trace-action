// Verifies scripts/otlp-receiver.mjs is a faithful, drop-in replacement for the
// otel-collector sidecar: its OTLP/JSON output must match what the real
// collector's file exporter writes for the same protobuf input.
//
// Fixtures in test/fixtures/dagger-check were captured from a real `dagger
// check` run of this repo (biome over the repo). `requests/*.bin` are the raw
// OTLP/protobuf export request bodies Dagger POSTed; `expected/{traces,logs}.jsonl`
// is the collector's file-exporter output produced by replaying those exact
// bytes through otel-collector-contrib. So the collector is the oracle — no
// hand-written expectations. (Fixtures are length-preserving-sanitized to strip
// local paths / names; that keeps the protobuf valid and the pairing intact.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import http from "node:http";
import { decodeTraces, decodeLogs, inflate, startServer, parseOtlpHeaders } from "../scripts/otlp-receiver.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const fx = join(here, "fixtures", "dagger-check");
const summarize = join(here, "..", "scripts", "summarize.mjs");

const canon = (x) =>
  Array.isArray(x)
    ? x.map(canon)
    : x && typeof x === "object"
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])]))
      : x;

const reqFiles = (kind) =>
  readdirSync(join(fx, "requests")).filter((f) => f.startsWith(kind) && f.endsWith(".bin")).sort();
const readReq = (f) => readFileSync(join(fx, "requests", f));
const expectedLines = (kind) =>
  readFileSync(join(fx, "expected", `${kind}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

for (const [kind, decode] of [["traces", decodeTraces], ["logs", decodeLogs]]) {
  test(`${kind}: each decoded batch matches the collector output`, () => {
    const files = reqFiles(kind);
    const expected = expectedLines(kind);
    assert.equal(files.length, expected.length, "one request body per collector batch line");
    assert.ok(files.length > 0, "fixtures present");
    files.forEach((f, i) => {
      const mine = decode(readReq(f));
      assert.deepEqual(canon(mine), canon(expected[i]), `batch ${i} (${f}) differs from collector`);
    });
  });
}

test("encoding contract: hex ids, string 64-bit ints, numeric enums", () => {
  const batch = decodeTraces(readReq(reqFiles("traces")[0]));
  const spans = batch.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans || []));
  const s = spans[0];
  assert.match(s.spanId, /^[0-9a-f]{16}$/, "spanId is 8-byte lowercase hex");
  assert.match(s.traceId, /^[0-9a-f]{32}$/, "traceId is 16-byte lowercase hex");
  assert.equal(typeof s.startTimeUnixNano, "string", "times are decimal strings");
  assert.match(s.startTimeUnixNano, /^[0-9]+$/);
  // Dagger tags every span with a numeric status code (OTLP OK == 1).
  const withStatus = spans.find((x) => x.status && "code" in x.status);
  assert.equal(typeof withStatus.status.code, "number", "status.code is numeric");
  // intValue is a string; arrayValue nests under .values.
  const attrs = spans.flatMap((x) => x.attributes || []);
  const intAttr = attrs.find((a) => "intValue" in a.value);
  if (intAttr) assert.equal(typeof intAttr.value.intValue, "string", "intValue is a string");
  const arrAttr = attrs.find((a) => "arrayValue" in a.value && a.value.arrayValue.values);
  if (arrAttr) assert.ok(Array.isArray(arrAttr.value.arrayValue.values));
});

test("gzip and identity bodies decode identically", () => {
  const raw = readReq(reqFiles("traces")[0]);
  const gz = gzipSync(raw);
  assert.deepEqual(inflate(gz, "gzip"), raw);
  assert.deepEqual(inflate(raw, "identity"), raw);
});

test("end-to-end: summarize output is identical to the collector's", () => {
  const dir = mkdtempSync(join(tmpdir(), "otlp-recv-"));
  for (const kind of ["traces", "logs"]) {
    const out = reqFiles(kind)
      .map((f) => JSON.stringify((kind === "traces" ? decodeTraces : decodeLogs)(readReq(f))))
      .join("\n");
    writeFileSync(join(dir, `${kind}.jsonl`), `${out}\n`);
  }
  const run = (d) => execFileSync(process.execPath, [summarize, d, "--title", "t"], { encoding: "utf8" });
  assert.equal(run(dir), run(join(fx, "expected")), "summary from receiver != summary from collector");
});

test("parseOtlpHeaders: comma-separated, percent-decoded key=value pairs", () => {
  assert.deepEqual(parseOtlpHeaders("authorization=Bearer%20xyz,x-tenant=acme"), {
    authorization: "Bearer xyz",
    "x-tenant": "acme",
  });
  assert.deepEqual(parseOtlpHeaders(""), {});
  assert.deepEqual(parseOtlpHeaders(undefined), {});
});

test("forward: tees the raw bytes + headers upstream while still capturing locally", async () => {
  // Sink standing in for the runner's pre-existing OTLP endpoint.
  const received = [];
  const sink = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200);
      res.end();
    });
  });
  sink.listen(0, "127.0.0.1");
  await new Promise((r) => sink.once("listening", r));
  const sinkPort = sink.address().port;

  const dir = mkdtempSync(join(tmpdir(), "otlp-fwd-"));
  const server = startServer({
    dataDir: dir,
    forward: {
      traces: { url: `http://127.0.0.1:${sinkPort}/v1/traces`, headers: { authorization: "Bearer t" } },
      logs: { url: `http://127.0.0.1:${sinkPort}/v1/logs`, headers: {} },
    },
  });
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;

  const raw = readReq(reqFiles("traces")[0]);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: raw,
    });
    assert.equal(res.status, 200, "Dagger still gets its 200 regardless of the tee");
    // Forwarding is fire-and-forget; give the sink a moment to receive it.
    for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => sink.close(r));
  }

  assert.equal(received.length, 1, "upstream received exactly one forwarded batch");
  const fwd = received[0];
  assert.equal(fwd.path, "/v1/traces");
  assert.deepEqual(fwd.body, raw, "bytes are forwarded verbatim");
  assert.equal(fwd.headers["content-type"], "application/x-protobuf");
  assert.equal(fwd.headers.authorization, "Bearer t", "configured auth header is attached");

  // The local capture is unaffected by forwarding.
  const local = readFileSync(join(dir, "traces.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(local.length, 1, "still captured locally");
  assert.deepEqual(canon(JSON.parse(local[0])), canon(decodeTraces(raw)));
});

test("live server: POSTing the request bodies reproduces the collector output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "otlp-srv-"));
  const server = startServer({ dataDir: dir });
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const post = (path, body, headers = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", ...headers },
      body,
    });
  try {
    for (const f of reqFiles("traces")) await post("/v1/traces", readReq(f));
    for (const f of reqFiles("logs")) await post("/v1/logs", readReq(f));
  } finally {
    await new Promise((r) => server.close(r));
  }
  for (const kind of ["traces", "logs"]) {
    const got = readFileSync(join(dir, `${kind}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const exp = expectedLines(kind);
    assert.equal(got.length, exp.length);
    got.forEach((b, i) => assert.deepEqual(canon(b), canon(exp[i]), `${kind} batch ${i} via HTTP`));
  }
});
