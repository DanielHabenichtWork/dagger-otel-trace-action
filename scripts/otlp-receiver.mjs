#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
// Dependency-free OTLP/HTTP receiver: the Docker-free alternative to the
// otel-collector sidecar. It accepts Dagger's OTLP/protobuf export requests on
// /v1/traces and /v1/logs and appends each request, decoded into the collector's
// OTLP/JSON shape, one batch per line to <data-dir>/{traces,logs}.jsonl — so
// scripts/viewer.html and scripts/summarize.mjs consume it unchanged.
//
// Why hand-decode protobuf: Dagger's Go OTLP exporter only speaks
// http/protobuf (no JSON encoding), so we decode ExportTraceServiceRequest /
// ExportLogsServiceRequest here. Field numbers are from the stable OTLP protos
// (opentelemetry/proto/{trace,logs,common,resource}/v1). The JSON encoding
// mirrors the collector's file exporter, verified against captured telemetry:
// ids → lowercase hex, 64-bit ints (times, intValue) → decimal strings, enums
// (kind, status.code, severityNumber) → numbers, doubles → numbers.
//
// usage (CLI, background collector):
//   node otlp-receiver.mjs <data-dir> [--port N] [--host H]
// It binds an ephemeral port by default, writes {port,pid,endpoint} to
// <data-dir>/receiver.json, and flushes + exits on SIGTERM. Writes are
// synchronous appends, so the files are durable without an explicit flush.
import http from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const TE = new TextDecoder();

// Scan a protobuf message into its top-level fields. Returns entries of
// {field, wire, val}: wire 0 -> BigInt, wire 1 -> 8-byte view, wire 2 -> bytes
// view, wire 5 -> 4-byte view.
function scan(buf) {
  const out = [];
  let i = 0;
  const readVarint = () => {
    let shift = 0n;
    let result = 0n;
    let b;
    do {
      b = buf[i++];
      result |= BigInt(b & 0x7f) << shift;
      shift += 7n;
    } while (b & 0x80);
    return result;
  };
  while (i < buf.length) {
    const tag = Number(readVarint());
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) out.push({ field, wire, val: readVarint() });
    else if (wire === 1) {
      out.push({ field, wire, val: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = Number(readVarint());
      out.push({ field, wire, val: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      out.push({ field, wire, val: buf.subarray(i, i + 4) });
      i += 4;
    } else break;
  }
  return out;
}

const str = (u8) => TE.decode(u8);
const hex = (u8) => Buffer.from(u8).toString("hex");
const dv = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const u64 = (u8) => dv(u8).getBigUint64(0, true).toString();
const f64 = (u8) => dv(u8).getFloat64(0, true);
const u32 = (u8) => dv(u8).getUint32(0, true);

// common/v1 AnyValue (oneof) and KeyValue.
function anyValue(buf) {
  for (const f of scan(buf)) {
    switch (f.field) {
      case 1:
        return { stringValue: str(f.val) };
      case 2:
        return { boolValue: f.val !== 0n };
      case 3:
        return { intValue: f.val.toString() };
      case 4:
        return { doubleValue: f64(f.val) };
      case 5: {
        const values = repeatedAnyValue(f.val);
        return { arrayValue: values.length ? { values } : {} };
      }
      case 6: {
        const values = repeatedKeyValue(f.val, 1);
        return { kvlistValue: values.length ? { values } : {} };
      }
      case 7:
        return { bytesValue: Buffer.from(f.val).toString("base64") };
    }
  }
  return {};
}
const repeatedAnyValue = (buf) =>
  scan(buf)
    .filter((f) => f.field === 1 && f.wire === 2)
    .map((f) => anyValue(f.val));
const repeatedKeyValue = (buf, fieldNum) =>
  scan(buf)
    .filter((f) => f.field === fieldNum && f.wire === 2)
    .map((f) => keyValue(f.val));
function keyValue(buf) {
  let key = "";
  let value = {};
  for (const f of scan(buf)) {
    if (f.field === 1) key = str(f.val);
    else if (f.field === 2) value = anyValue(f.val);
  }
  return { key, value };
}

// Assemble an object, dropping protobuf default (absent/zero) values to match
// the collector's protojson output.
function withAttrs(obj, attrs) {
  if (attrs.length) obj.attributes = attrs;
  return obj;
}

function resource(buf) {
  return withAttrs({}, repeatedKeyValue(buf, 1));
}
function scopeMsg(buf) {
  const sc = {};
  const attrs = [];
  for (const f of scan(buf)) {
    if (f.field === 1 && f.val.length) sc.name = str(f.val);
    else if (f.field === 2 && f.val.length) sc.version = str(f.val);
    else if (f.field === 3) attrs.push(keyValue(f.val));
  }
  return withAttrs(sc, attrs);
}

function status(buf) {
  const st = {};
  for (const f of scan(buf)) {
    if (f.field === 2 && f.val.length) st.message = str(f.val);
    else if (f.field === 3) {
      const code = Number(f.val);
      if (code) st.code = code;
    }
  }
  return st;
}

function event(buf) {
  const e = {};
  const attrs = [];
  for (const f of scan(buf)) {
    if (f.field === 1) e.timeUnixNano = u64(f.val);
    else if (f.field === 2) e.name = str(f.val);
    else if (f.field === 3) attrs.push(keyValue(f.val));
    else if (f.field === 4) {
      const d = Number(f.val);
      if (d) e.droppedAttributesCount = d;
    }
  }
  return withAttrs(e, attrs);
}
function link(buf) {
  const l = {};
  const attrs = [];
  for (const f of scan(buf)) {
    switch (f.field) {
      case 1:
        l.traceId = hex(f.val);
        break;
      case 2:
        l.spanId = hex(f.val);
        break;
      case 3:
        if (f.val.length) l.traceState = str(f.val);
        break;
      case 4:
        attrs.push(keyValue(f.val));
        break;
      case 5: {
        const d = Number(f.val);
        if (d) l.droppedAttributesCount = d;
        break;
      }
      case 6: {
        const flags = u32(f.val);
        if (flags) l.flags = flags;
        break;
      }
    }
  }
  return withAttrs(l, attrs);
}

function span(buf) {
  const s = {};
  const attrs = [];
  for (const f of scan(buf)) {
    switch (f.field) {
      case 1:
        s.traceId = hex(f.val);
        break;
      case 2:
        s.spanId = hex(f.val);
        break;
      case 3:
        if (f.val.length) s.traceState = str(f.val);
        break;
      case 4:
        if (f.val.length) s.parentSpanId = hex(f.val);
        break;
      case 5:
        s.name = str(f.val);
        break;
      case 6: {
        const kind = Number(f.val);
        if (kind) s.kind = kind;
        break;
      }
      case 7:
        s.startTimeUnixNano = u64(f.val);
        break;
      case 8:
        s.endTimeUnixNano = u64(f.val);
        break;
      case 9:
        attrs.push(keyValue(f.val));
        break;
      case 10: {
        const d = Number(f.val);
        if (d) s.droppedAttributesCount = d;
        break;
      }
      case 11:
        if (!s.events) s.events = [];
        s.events.push(event(f.val));
        break;
      case 12: {
        const d = Number(f.val);
        if (d) s.droppedEventsCount = d;
        break;
      }
      case 13:
        if (!s.links) s.links = [];
        s.links.push(link(f.val));
        break;
      case 14: {
        const d = Number(f.val);
        if (d) s.droppedLinksCount = d;
        break;
      }
      case 15:
        s.status = status(f.val);
        break;
      case 16: {
        const flags = u32(f.val);
        if (flags) s.flags = flags;
        break;
      }
    }
  }
  return withAttrs(s, attrs);
}

function scopeSpans(buf) {
  // pdata always materializes scope, so the collector emits it (>= {}) even
  // when the wire omits an empty InstrumentationScope.
  const o = { scope: {} };
  const spans = [];
  for (const f of scan(buf)) {
    if (f.field === 1) o.scope = scopeMsg(f.val);
    else if (f.field === 2) spans.push(span(f.val));
    else if (f.field === 3 && f.val.length) o.schemaUrl = str(f.val);
  }
  if (spans.length) o.spans = spans;
  return o;
}
function resourceSpans(buf) {
  const o = { resource: {} };
  const ss = [];
  for (const f of scan(buf)) {
    if (f.field === 1) o.resource = resource(f.val);
    else if (f.field === 2) ss.push(scopeSpans(f.val));
    else if (f.field === 3 && f.val.length) o.schemaUrl = str(f.val);
  }
  if (ss.length) o.scopeSpans = ss;
  return o;
}
export function decodeTraces(buf) {
  const rs = scan(buf)
    .filter((f) => f.field === 1 && f.wire === 2)
    .map((f) => resourceSpans(f.val));
  return { resourceSpans: rs };
}

function logRecord(buf) {
  const r = {};
  const attrs = [];
  for (const f of scan(buf)) {
    switch (f.field) {
      case 1:
        r.timeUnixNano = u64(f.val);
        break;
      case 2: {
        const n = Number(f.val);
        if (n) r.severityNumber = n;
        break;
      }
      case 3:
        if (f.val.length) r.severityText = str(f.val);
        break;
      case 5:
        r.body = anyValue(f.val);
        break;
      case 6:
        attrs.push(keyValue(f.val));
        break;
      case 8: {
        const flags = u32(f.val);
        if (flags) r.flags = flags;
        break;
      }
      case 9:
        if (f.val.length) r.traceId = hex(f.val);
        break;
      case 10:
        if (f.val.length) r.spanId = hex(f.val);
        break;
      case 11:
        r.observedTimeUnixNano = u64(f.val);
        break;
    }
  }
  return withAttrs(r, attrs);
}
function scopeLogs(buf) {
  const o = { scope: {} };
  const records = [];
  for (const f of scan(buf)) {
    if (f.field === 1) o.scope = scopeMsg(f.val);
    else if (f.field === 2) records.push(logRecord(f.val));
    else if (f.field === 3 && f.val.length) o.schemaUrl = str(f.val);
  }
  if (records.length) o.logRecords = records;
  return o;
}
function resourceLogs(buf) {
  const o = { resource: {} };
  const sl = [];
  for (const f of scan(buf)) {
    if (f.field === 1) o.resource = resource(f.val);
    else if (f.field === 2) sl.push(scopeLogs(f.val));
    else if (f.field === 3 && f.val.length) o.schemaUrl = str(f.val);
  }
  if (sl.length) o.scopeLogs = sl;
  return o;
}
export function decodeLogs(buf) {
  const rl = scan(buf)
    .filter((f) => f.field === 1 && f.wire === 2)
    .map((f) => resourceLogs(f.val));
  return { resourceLogs: rl };
}

// Decode a gzip/deflate-or-identity request body into raw protobuf bytes.
export function inflate(body, contentEncoding) {
  const enc = (contentEncoding || "").toLowerCase();
  if (enc.includes("gzip")) return zlib.gunzipSync(body);
  if (enc.includes("deflate")) return zlib.inflateSync(body);
  return body;
}

export function startServer({ dataDir, port = 0, host = "127.0.0.1" }) {
  mkdirSync(dataDir, { recursive: true });
  const files = {
    traces: join(dataDir, "traces.jsonl"),
    logs: join(dataDir, "logs.jsonl"),
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const m = (req.url || "").match(/\/v1\/(traces|logs|metrics)/);
        if (m && m[1] !== "metrics") {
          const body = inflate(Buffer.concat(chunks), req.headers["content-encoding"]);
          const batch = m[1] === "traces" ? decodeTraces(body) : decodeLogs(body);
          appendFileSync(files[m[1]], `${JSON.stringify(batch)}\n`);
        }
      } catch (e) {
        process.stderr.write(`otlp-receiver: decode error: ${e.stack || e}\n`);
      }
      // Minimal OTLP success: 200 with an empty body is accepted by the SDK.
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    });
    req.on("error", () => {
      try {
        res.writeHead(400);
        res.end();
      } catch {}
    });
  });
  server.listen(port, host);
  return server;
}

// Run the server only when invoked directly (argv[1] is the script path); stays
// a pure module when imported (tests, or `node -e`, where argv[1] is undefined).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let dataDir = null;
  let port = 0;
  const host = "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--host") {
      /* host is fixed to loopback */ i++;
    } else if (!dataDir) dataDir = args[i];
  }
  if (!dataDir) {
    process.stderr.write("usage: otlp-receiver.mjs <data-dir> [--port N]\n");
    process.exit(2);
  }
  const server = startServer({ dataDir, port, host });
  server.on("listening", () => {
    const info = { port: server.address().port, pid: process.pid };
    info.endpoint = `http://${host}:${info.port}`;
    writeFileSync(join(dataDir, "receiver.json"), JSON.stringify(info));
    process.stderr.write(`otlp-receiver on ${info.endpoint} (pid ${info.pid})\n`);
    process.stdout.write(`${JSON.stringify(info)}\n`);
  });
  server.on("error", (e) => {
    process.stderr.write(`otlp-receiver: ${e.message}\n`);
    process.exit(1);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
