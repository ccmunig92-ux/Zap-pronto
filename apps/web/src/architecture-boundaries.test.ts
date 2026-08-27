import { describe, expect, it } from "vitest";

const productionSources = import.meta.glob<string>(["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx"], {
  eager: true,
  import: "default",
  query: "?raw",
});

describe("canonical frontend boundaries", () => {
  it("does not introduce the Lovable session, base URL, or parallel zap client", () => {
    const violations = Object.entries(productionSources).flatMap(([path, source]) => {
      const reasons = [
        source.includes("__ZAP_SESSION__") ? "parallel browser session" : undefined,
        source.includes("VITE_API_BASE_URL") ? "parallel API base URL" : undefined,
        /(?:from|import\()\s*["'][^"']*lib\/zap(?:\/|["'])/.test(source) ? "parallel zap client import" : undefined,
      ].filter((reason): reason is string => Boolean(reason));
      return reasons.map((reason) => `${path}: ${reason}`);
    });

    expect(violations).toEqual([]);
  });
});
