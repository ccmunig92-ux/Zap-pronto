import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../.github/workflows/staging-images.yml", import.meta.url), "utf8");

test("publication is manual, default-branch-only and environment-scoped", () => {
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /github\.ref_name == github\.event\.repository\.default_branch/);
  assert.match(source, /environment: oidc-homologation/);
  assert.doesNotMatch(source, /^  (?:pull_request|push):/m);
});

test("both candidates are scanned before any registry publication", () => {
  const apiScan = source.indexOf("Scan API for critical vulnerabilities");
  const apiPublish = source.indexOf("Publish approved API");
  const webScan = source.indexOf("Scan web for critical vulnerabilities");
  const webPublish = source.indexOf("Publish approved web");
  assert.ok(apiScan > 0 && apiScan < apiPublish);
  assert.ok(webScan > 0 && webScan < webPublish);
  assert.equal((source.match(/load: true/g) ?? []).length, 2);
  assert.equal((source.match(/push: true/g) ?? []).length, 2);
  assert.equal((source.match(/sbom: true/g) ?? []).length, 2);
});

test("third-party actions are pinned to full commits", () => {
  for (const line of source.split(/\r?\n/).filter((value) => value.includes("uses:"))) {
    assert.match(line, /uses: [^\s@]+@[a-f0-9]{40}(?:\s+#.*)?$/);
  }
});
