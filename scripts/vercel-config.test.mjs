import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../apps/web/vercel.json", import.meta.url), "utf8"),
);

test("Vercel serves Vite client-side routes through index.html", () => {
  assert.deepEqual(config.rewrites, [
    {
      source: "/((?!v1(?:/|$)).*)",
      destination: "/index.html",
    },
  ]);
});

test("Vercel never turns API failures into the SPA HTML document", () => {
  const source = config.rewrites[0]?.source;
  assert.equal(new RegExp(`^${source}$`, "u").test("/configuracoes/canais"), true);
  assert.equal(new RegExp(`^${source}$`, "u").test("/v1/me"), false);
});
