/**
 * CI for dagger-otel-trace: Biome formatting + lint of the repo's own JS/JSON,
 * plus the Node unit tests.
 *
 * `check` (Biome) and `test` (Node's test runner) are both gates — each fails
 * the run on any issue and is registered as a Dagger check, so `dagger check`
 * (and `dagger-trace check`) runs both. `format` applies Biome's fixes and
 * returns the updated tree. Everything runs in a pinned node container over the
 * whole repo — Biome's own config (biome.json) scopes what gets checked.
 */
import { dag, Container, Directory, object, func, check, argument } from "@dagger.io/dagger"

const BIOME = "@biomejs/biome@1.9.4"

@object()
export class Ci {
  /**
   * Check formatting and lint with Biome. Fails if anything is not formatted
   * or trips a lint rule — the CI gate. Registered as a Dagger check, so it
   * runs via `dagger check` (and therefore `dagger-trace check`).
   */
  @func()
  @check()
  check(@argument({ defaultPath: "/" }) source: Directory): Container {
    return this.node(source).withExec(["npx", "--yes", BIOME, "check", "."])
  }

  /**
   * Run the Node test suite (built-in runner). Verifies scripts/otlp-receiver.mjs
   * decodes OTLP/protobuf into exactly the JSON the otel collector produces,
   * against fixtures captured from a real run. Registered as a Dagger check.
   */
  @func()
  @check()
  test(@argument({ defaultPath: "/" }) source: Directory): Container {
    return this.node(source)
      .withExec(["apk", "add", "--no-cache", "bash"])
      .withExec(["npm", "test"])
  }

  /**
   * Apply Biome's formatting/lint fixes and return the updated files (export
   * with `dagger call format export --path=.`).
   */
  @func()
  format(@argument({ defaultPath: "/" }) source: Directory): Directory {
    return this.node(source)
      .withExec(["npx", "--yes", BIOME, "check", "--write", "."])
      .directory("/src")
  }

  private node(source: Directory): Container {
    return dag
      .container()
      .from("node:22-alpine")
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
  }
}
