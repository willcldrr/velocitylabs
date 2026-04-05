/// <reference types="vitest" />
import { defineConfig } from "vitest/config"
import path from "node:path"

/**
 * Vitest config.
 *
 * Intentionally minimal — a single `tests/` glob with path aliases mirroring
 * tsconfig so tests can import from "@/lib/...". The node environment is
 * enough for the current suite; JSDOM can be added later when the first
 * component test lands.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Wave 3-A scope: measure coverage only against the files touched in
      // Waves 1–2 (the remediation scope). Untouched modules are intentionally
      // excluded from the threshold so we're not on the hook for testing
      // things we didn't change.
      include: [
        "lib/crypto.ts",
        "lib/log.ts",
        "lib/safe-fetch.ts",
        "lib/rate-limit.ts",
        "lib/api-rate-limit.ts",
        "lib/auth-rate-limit.ts",
        "lib/webhook-idempotency.ts",
        "lib/survey-auth.ts",
        "app/api/admin/restore-session/**",
        "app/api/instagram/callback/**",
        "app/api/auth/verify-otp/**",
        "app/api/payments/webhook/**",
        "app/api/stripe-webhook/**",
        "app/api/bookings/checkout/**",
      ],
      exclude: ["**/*.test.ts", "**/*.d.ts", "tests/**"],
      // 40% is the FLOOR (prevent regression), not the target.
      thresholds: {
        lines: 40,
        branches: 30,
        functions: 40,
        statements: 40,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
})
