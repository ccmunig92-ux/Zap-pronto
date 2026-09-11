import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../apps/web/vercel.json", import.meta.url), "utf8"),
);
const nginxConfig = await readFile(new URL("../deploy/web/default.conf.template", import.meta.url), "utf8");
const oidcAuthority = "https://dev-664ov20cjjwcr4fx.us.auth0.com";

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
  assert.deepEqual(config.headers[0],
    {
      source: "/v1/:path*",
      headers: [
        { key: "Cache-Control", value: "no-store" },
        { key: "Vercel-CDN-Cache-Control", value: "no-store" },
      ],
    });
});

test("Vercel serves the SPA with the same security boundary as staging", () => {
  assert.equal(config.headers.length, 2);
  const nginxCsp = nginxConfig.match(/default "([^"]+)";/u)?.[1]
    .replace("${OIDC_AUTHORITY_ORIGIN}", oidcAuthority);
  assert.ok(nginxCsp);
  assert.deepEqual(config.headers[1], {
    source: "/((?!v1(?:/|$)).*)",
    headers: [
      {
        key: "Content-Security-Policy",
        value: nginxCsp,
      },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    ],
  });

  const spaHeaderSource = new RegExp(`^${config.headers[1].source}$`, "u");
  for (const path of ["/", "/assets/app.js", "/oidc/callback", "/v10/example"]) {
    assert.equal(spaHeaderSource.test(path), true, `${path} must receive SPA security headers`);
  }
  for (const path of ["/v1", "/v1/me"]) {
    assert.equal(spaHeaderSource.test(path), false, `${path} must preserve upstream API headers`);
  }
});
