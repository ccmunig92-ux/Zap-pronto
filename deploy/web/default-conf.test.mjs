import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const configuration = readFileSync(new URL("./default.conf.template", import.meta.url), "utf8");

function location(path) {
  const marker = `location = ${path} {`;
  const start = configuration.indexOf(marker);
  assert.notEqual(start, -1, `${path} must have an exact location`);
  const next = configuration.indexOf("\n  location ", start + marker.length);
  return configuration.slice(start, next === -1 ? configuration.length : next);
}

test("expõe somente o liveness da API sem cair no fallback SPA", () => {
  const live = location("/health/live");
  assert.match(live, /proxy_pass \$zap_health_live_upstream;/);
  assert.match(live, /Cache-Control "no-store"/);

  const ready = location("/health/ready");
  assert.match(ready, /return 404;/);
  assert.doesNotMatch(ready, /proxy_pass/);
});

test("não registra segredos da query e renova DNS da API", () => {
  const logFormat = configuration.match(/log_format zap_safe[^;]+;/s)?.[0];
  assert.ok(logFormat);
  assert.match(logFormat, /\$uri/);
  assert.doesNotMatch(logFormat, /\$(?:request|request_uri|args|http_referer)\b/);
  assert.match(configuration, /resolver 127\.0\.0\.11 valid=5s ipv6=off;/);
  assert.match(configuration, /set \$zap_api_upstream "\$\{API_UPSTREAM\}";/);
  assert.match(configuration, /proxy_pass \$zap_api_upstream;/);
});
