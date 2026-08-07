import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const viewer = readFileSync(join(root, "scripts", "viewer.html"), "utf8");

test("bundle embeds the current package version", () => {
  const dir = mkdtempSync(join(tmpdir(), "dagger-trace-meta-"));
  try {
    writeFileSync(join(dir, "traces.jsonl"), "{}\n");
    const out = join(dir, "trace.html");
    execFileSync("bash", [join(root, "scripts", "bundle.sh"), dir, out]);

    const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const html = readFileSync(out, "utf8");
    assert.match(html, new RegExp(`<script type="text/plain" id="data-viewer-version">${version.replaceAll(".", "\\.")}</script>`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repository, branch, and commit metadata render as links", () => {
  const start = viewer.indexOf("function safeHttpUrl");
  const end = viewer.indexOf("function applyMeta", start);
  assert.ok(start >= 0 && end > start, "could not locate metadata helpers in viewer.html");
  const helpers = viewer.slice(start, end);
  const { metaHtml, viewerReleaseUrl } = new Function(
    `const esc = s => s.replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" }[c]));\n${helpers}\nreturn { metaHtml, viewerReleaseUrl };`,
  )();

  const html = metaHtml({
    repo: "acme/widgets",
    repoUrl: "https://github.com/acme/widgets",
    ref: "feature/new-ui",
    sha: "0123456789abcdef",
    runUrl: "https://github.com/acme/widgets/actions/runs/42",
    date: "2026-08-07T12:00:00Z",
  });

  assert.match(html, /href="https:\/\/github\.com\/acme\/widgets">acme\/widgets<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/widgets\/tree\/feature\/new-ui">feature\/new-ui<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/widgets\/commit\/0123456789abcdef">0123456789<\/a>/);
  assert.ok(html.indexOf("acme/widgets") < html.indexOf("feature/new-ui"));
  assert.ok(html.indexOf("feature/new-ui") < html.indexOf("0123456789"));
  assert.ok(html.indexOf("0123456789") < html.indexOf("workflow run"));
  assert.ok(html.indexOf("workflow run") < html.indexOf("2026-08-07T12:00:00Z"));
  assert.equal(
    viewerReleaseUrl("https://github.com/DanielHabenichtWork/dagger-otel-trace-action", "1.8.0"),
    "https://github.com/DanielHabenichtWork/dagger-otel-trace-action/releases/tag/v1.8.0",
  );
});
