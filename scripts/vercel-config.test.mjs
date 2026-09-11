import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../apps/web/vercel.json", import.meta.url), "utf8"),
);

test("Vercel serves Vite client-side routes through index.html", () => {
  assert.deepEqual(config.rewrites, [
    {
      source: "/v1/:path*",
      destination: "https://staging.clinicaprontomedic.online/v1/:path*",
    },
    {
      source: "/((?!v1(?:/|$)).*)",
      destination: "/index.html",
    },
  ]);
});

test("Vercel never turns API failures into the SPA HTML document", () => {
  const source = config.rewrites[1]?.source;
  assert.equal(new RegExp(`^${source}$`, "u").test("/configuracoes/canais"), true);
  assert.equal(new RegExp(`^${source}$`, "u").test("/v1/me"), false);
});

test("Vercel proxies the same-origin API only to the canonical HTTPS staging origin", () => {
  assert.deepEqual(config.rewrites[0], {
    source: "/v1/:path*",
    destination: "https://staging.clinicaprontomedic.online/v1/:path*",
  });
  assert.equal(config.rewrites[0].destination.startsWith("https://"), true);
});

test("Vercel disables browser and CDN caching for every proxied API response", () => {
  assert.deepEqual(config.headers, [
    {
      source: "/v1/:path*",
      headers: [
        { key: "Cache-Control", value: "no-store" },
        { key: "Vercel-CDN-Cache-Control", value: "no-store" },
      ],
    },
  ]);
});
