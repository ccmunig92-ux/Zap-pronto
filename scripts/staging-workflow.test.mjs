import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../.github/workflows/staging-images.yml", import.meta.url), "utf8");
const oidcSource = await readFile(new URL("../.github/workflows/oidc-homologation.yml", import.meta.url), "utf8");
const apiDockerfile = await readFile(new URL("../Dockerfile.api", import.meta.url), "utf8");
const webDockerfile = await readFile(new URL("../Dockerfile.web", import.meta.url), "utf8");

test("publication is manual, default-branch-only and environment-scoped", () => {
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /github\.ref_name == github\.event\.repository\.default_branch/);
  assert.match(source, /vars\.STAGING_RELEASE_ENABLED == 'true'/);
  assert.match(source, /environment: oidc-homologation/);
  assert.doesNotMatch(source, /^  (?:pull_request|push):/m);
});

test("public web build validates and forwards the API audience", () => {
  assert.match(source, /OIDC_AUDIENCE: \$\{\{ vars\.OIDC_AUDIENCE \}\}/);
  assert.match(source, /test -n "\$OIDC_AUDIENCE"/);
  assert.equal((source.match(/VITE_OIDC_AUDIENCE=\$\{\{ vars\.OIDC_AUDIENCE \}\}/g) ?? []).length, 1);
  assert.equal((source.match(/VITE_OIDC_SCOPE=openid profile email/g) ?? []).length, 1);
  assert.equal((source.match(/VITE_OIDC_AUTOMATIC_SILENT_RENEW=true/g) ?? []).length, 1);
});

test("external OIDC uses the canonical harness in restricted external mode", () => {
  assert.match(oidcSource, /workflow_dispatch:/);
  assert.match(oidcSource, /mode:[\s\S]*homologate[\s\S]*recover-only/);
  assert.match(oidcSource, /environment: oidc-homologation/);
  assert.match(oidcSource, /E2E_OIDC_TARGET: "external"/);
  assert.match(oidcSource, /E2E_EXTERNAL_ACCOUNT_BLOCK_ALLOWED: "true"/);
  assert.match(oidcSource, /concurrency:[\s\S]*group: oidc-external-homologation[\s\S]*cancel-in-progress: false/);
  assert.match(oidcSource, /if: \$\{\{ always\(\) && github\.ref_name == github\.event\.repository\.default_branch \}\}/);
  assert.match(oidcSource, /Recover dedicated attendant account[\s\S]*if: \$\{\{ always\(\) \}\}[\s\S]*recuperação idempotente/);
  assert.equal((oidcSource.match(/environment: oidc-homologation/g) ?? []).length, 1);
  assert.match(oidcSource, /--grep/);
  assert.equal((oidcSource.match(/test:e2e:oidc --grep/g) ?? []).length, 2);
  assert.doesNotMatch(oidcSource, /test:e2e:oidc -- --grep/);
  assert.doesNotMatch(oidcSource, /^  (?:pull_request|push):/m);
});

test("each published digest is built once, scanned exactly and only then attested", () => {
  const apiScan = source.indexOf("Scan the published API digest");
  const apiAttest = source.indexOf("Attest API provenance");
  const webScan = source.indexOf("Scan the published web digest");
  const webAttest = source.indexOf("Attest web provenance");
  assert.ok(apiScan > 0 && apiScan < apiAttest);
  assert.ok(webScan > 0 && webScan < webAttest);
  assert.equal((source.match(/file: Dockerfile\.api/g) ?? []).length, 1);
  assert.equal((source.match(/file: Dockerfile\.web/g) ?? []).length, 1);
  assert.match(source, /image-ref: ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/zap-pronto-api@\$\{\{ steps\.api\.outputs\.digest \}\}/);
  assert.match(source, /image-ref: ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/zap-pronto-web@\$\{\{ steps\.web\.outputs\.digest \}\}/);
  assert.doesNotMatch(source, /load: true/);
  assert.equal((source.match(/push: true/g) ?? []).length, 2);
  assert.equal((source.match(/sbom: true/g) ?? []).length, 2);
});

test("published images carry the exact source revision instead of inherited base labels", () => {
  assert.equal((source.match(/VCS_REF=\$\{\{ github\.sha \}\}/g) ?? []).length, 2);
  for (const dockerfile of [apiDockerfile, webDockerfile]) {
    assert.match(dockerfile, /ARG VCS_REF=unknown/);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$VCS_REF/);
    assert.match(dockerfile, /org\.opencontainers\.image\.source="https:\/\/github\.com\/ccmunig92-ux\/Zap-pronto"/);
  }
  assert.match(apiDockerfile, /ZAP_RELEASE_ID=\$VCS_REF/);
});

test("third-party actions are pinned to full commits", () => {
  for (const line of source.split(/\r?\n/).filter((value) => value.includes("uses:"))) {
    assert.match(line, /uses: [^\s@]+@[a-f0-9]{40}(?:\s+#.*)?$/);
  }
});
