/**
 * CI for dagger-otel-trace: Biome formatting + lint of the repo's own JS/JSON.
 *
 * `check` is the gate (fails on any issue); `format` applies the fixes and
 * returns the updated tree. Both run Biome in a pinned node container over the
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
    return this.biome(source).withExec(["npx", "--yes", BIOME, "check", "."])
  }

  /**
   * Apply Biome's formatting/lint fixes and return the updated files (export
   * with `dagger call format export --path=.`).
   */
  @func()
  format(@argument({ defaultPath: "/" }) source: Directory): Directory {
    return this.biome(source)
      .withExec(["npx", "--yes", BIOME, "check", "--write", "."])
      .directory("/src")
  }

  private biome(source: Directory): Container {
    return dag
      .container()
      .from("node:22-alpine")
      .withMountedDirectory("/src", source)
      .withWorkdir("/src")
  }
}
