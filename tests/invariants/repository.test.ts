/**
 * Repository-level invariants enforced by grepping the source tree.
 *
 * These guard against regressions of Waves 1–2 remediations:
 *  - LB-7: no `console.*` in server-side code (app/api and lib).
 *  - LB-10: no file imports the internal `rateLimitStore` outside the
 *    `lib/rate-limit.ts` module itself.
 *  - LB-9: all outbound HTTP inside app/api/** and lib/** must go through
 *    `safeFetch`/`safeFetchAllowInternal`, not raw `fetch(`.
 *
 * The scanner deliberately walks the tree with readdirSync so it has no
 * external dependency.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = process.cwd()
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "tests",
  "coverage",
  ".vercel",
])

function walk(
  dir: string,
  exts: RegExp,
  visit: (path: string, body: string) => void
) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, exts, visit)
    else if (exts.test(entry)) {
      visit(p, readFileSync(p, "utf8"))
    }
  }
}

describe("repository invariants", () => {
  it("no console.log/info/warn/error/debug in server-side code (app/api + lib, .ts only)", () => {
    const hits: string[] = []
    const re = /\bconsole\.(log|info|warn|error|debug)\s*\(/
    const scan = (root: string) =>
      walk(root, /\.ts$/, (path, body) => {
        // .ts only — .tsx client components are out of scope for LB-7.
        if (re.test(body)) hits.push(relative(ROOT, path))
      })
    scan(join(ROOT, "app", "api"))
    scan(join(ROOT, "lib"))
    expect(hits).toEqual([])
  })

  it("no file outside lib/rate-limit.ts references `rateLimitStore`", () => {
    const hits: string[] = []
    walk(join(ROOT, "lib"), /\.(ts|tsx)$/, (path, body) => {
      if (body.includes("rateLimitStore") && !path.endsWith("lib/rate-limit.ts")) {
        hits.push(relative(ROOT, path))
      }
    })
    walk(join(ROOT, "app"), /\.(ts|tsx)$/, (path, body) => {
      if (body.includes("rateLimitStore")) hits.push(relative(ROOT, path))
    })
    expect(hits).toEqual([])
  })

  it("no raw `fetch(` calls in app/api/** or lib/** outside lib/safe-fetch.ts", () => {
    // Match an unqualified `fetch(` token that is NOT inside a single-line
    // comment or string — a string/line-based scan is good enough to catch
    // regressions; false positives inside multi-line strings are rare.
    const fetchCall = /(?<![.a-zA-Z_$])fetch\s*\(/
    const hits: string[] = []
    const scan = (root: string) => {
      walk(root, /\.(ts|tsx)$/, (path, body) => {
        if (path.endsWith(join("lib", "safe-fetch.ts"))) return
        const lines = body.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const trimmed = line.trim()
          // Skip comments and obvious string literals containing "fetch("
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue
          if (!fetchCall.test(line)) continue
          // Allow safeFetch / safeFetchAllowInternal (the regex already
          // excludes `.fetch(` via lookbehind, but these helpers don't use
          // dot-access either). Filter by name.
          if (/\bsafe(?:Fetch|FetchAllowInternal)\s*\(/.test(line)) continue
          hits.push(`${relative(ROOT, path)}:${i + 1}`)
        }
      })
    }
    scan(join(ROOT, "app", "api"))
    scan(join(ROOT, "lib"))
    expect(hits).toEqual([])
  })
})
