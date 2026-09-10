import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../apps/web/vercel.json", import.meta.url), "utf8"),
);

test("Vercel serves Vite client-side routes through index.html", () => {
  assert.deepEqual(config.rewrites, [
    {
      source: "/(.*)",
      destination: "/index.html",
    },
  ]);
});
