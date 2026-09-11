import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../.github/workflows/staging-images.yml", import.meta.url), "utf8");
const oidcSource = await readFile(new URL("../.github/workflows/oidc-homologation.yml", import.meta.url), "utf8");
const oidcSpec = await readFile(new URL("../apps/web/e2e/shell-oidc.spec.ts", import.meta.url), "utf8");
const stagingReadme = await readFile(new URL("../deploy/staging/README.md", import.meta.url), "utf8");
const apiDockerfile = await readFile(new URL("../Dockerfile.api", import.meta.url), "utf8");
const webDockerfile = await readFile(new URL("../Dockerfile.web", import.meta.url), "utf8");
const diagnosticStart = oidcSpec.indexOf("async function safeAvailabilitySnapshot");
const diagnosticEnd = oidcSpec.indexOf("async function changeOwnAvailability", diagnosticStart);
const safeDiagnosticSource = oidcSpec.slice(diagnosticStart, diagnosticEnd);
const externalInboxStart = oidcSpec.indexOf('test("inbound materializado permite claim e devolução segura à fila"');
const externalInboxEnd = oidcSpec.indexOf('test("resposta humana TEXT fica QUEUED local', externalInboxStart);
const externalInboxSource = oidcSpec.slice(externalInboxStart, externalInboxEnd);

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
  assert.match(oidcSource, /homologate:[\s\S]*if: \$\{\{ github\.ref_name == github\.event\.repository\.default_branch && inputs\.mode == 'homologate' \}\}/);
  assert.match(oidcSource, /recovery:[\s\S]*needs: homologate[\s\S]*if: \$\{\{ always\(\) && github\.ref_name == github\.event\.repository\.default_branch \}\}/);
  assert.match(oidcSource, /Recover dedicated attendant account[\s\S]*if: \$\{\{ always\(\) \}\}[\s\S]*recuperação idempotente/);
  assert.equal((oidcSource.match(/environment: oidc-homologation/g) ?? []).length, 2);
  assert.match(oidcSource, /--grep/);
  assert.equal((oidcSource.match(/test:e2e:oidc --grep/g) ?? []).length, 3);
  assert.doesNotMatch(oidcSource, /test:e2e:oidc -- --grep/);
  assert.doesNotMatch(oidcSource, /^  (?:pull_request|push):/m);
});

test("external Inbox fixture is isolated behind pinned SSH and always cleaned", () => {
  assert.match(oidcSource, /E2E_INBOX_FIXTURE_KEY: \$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  for (const value of ["STAGING_FIXTURE_SSH_HOST", "STAGING_FIXTURE_SSH_PORT", "STAGING_FIXTURE_SSH_USER"]) {
    assert.match(oidcSource, new RegExp(`vars\\.${value}`));
  }
  for (const value of ["STAGING_FIXTURE_SSH_PRIVATE_KEY", "STAGING_FIXTURE_SSH_KNOWN_HOSTS"]) {
    assert.match(oidcSource, new RegExp(`secrets\\.${value}`));
  }
  assert.equal((oidcSource.match(/-o BatchMode=yes/g) ?? []).length, 3);
  assert.equal((oidcSource.match(/-o PasswordAuthentication=no/g) ?? []).length, 3);
  assert.equal((oidcSource.match(/-o StrictHostKeyChecking=yes/g) ?? []).length, 3);
  assert.equal((oidcSource.match(/UserKnownHostsFile=/g) ?? []).length, 3);
  assert.match(oidcSource, /Prepare isolated staging Inbox fixture[\s\S]*"prepare \$E2E_INBOX_FIXTURE_KEY"/);
  assert.match(oidcSource, /Verify isolated staging Inbox fixture[\s\S]*if: \$\{\{ always\(\) && inputs\.mode == 'homologate' \}\}[\s\S]*"verify \$E2E_INBOX_FIXTURE_KEY"/);
  assert.match(oidcSource, /recovery:[\s\S]*Configure restricted staging fixture SSH for recovery[\s\S]*Cleanup isolated staging Inbox fixture[\s\S]*"cleanup \$E2E_INBOX_FIXTURE_KEY"[\s\S]*actions\/checkout@[a-f0-9]{40}[\s\S]*Recover dedicated attendant account/);
  assert.match(oidcSource, /Cleanup isolated staging Inbox fixture[\s\S]*actions\/checkout@[a-f0-9]{40}[\s\S]*if: \$\{\{ always\(\) \}\}[\s\S]*Install isolated recovery browser runtime[\s\S]*if: \$\{\{ always\(\) \}\}/);
  assert.match(oidcSource, /Exercise external Inbox claim reload and requeue[\s\S]*inbound materializado permite claim e devolução segura à fila/);
  assert.match(oidcSource, /Exercise external Inbox claim reload and requeue[\s\S]*E2E_FORBID_SKIPS: "true"/);
  assert.match(oidcSource, /Recover dedicated attendant account[\s\S]*E2E_ATTENDANT_USERNAME: \$\{\{ secrets\.E2E_ATTENDANT_USERNAME \}\}[\s\S]*"recuperação idempotente"/);
  assert.match(oidcSpec, /recuperação idempotente restaura disponibilidade OFFLINE/);
  assert.match(oidcSpec, /if\(url\.origin!==baseOrigin\)crossOriginRequests\.push/);
  assert.match(oidcSpec, /expect\(crossOriginRequests\)\.toEqual\(\[\]\)/);
  assert.match(oidcSpec, /expect\(requeue\?\.\[1\]\)\.toBe\(claimMutation\?\.\[1\]\)/);
  assert.match(oidcSpec, /expect\(forbiddenOutbound\)\.toEqual\(\[\]\)/);
  assert.match(safeDiagnosticSource, /ASSIGNMENT_OUTSIDE_SHIFT/);
  assert.match(safeDiagnosticSource, /availability_not_available/);
  assert.match(safeDiagnosticSource, /capacity_exhausted/);
  assert.match(safeDiagnosticSource, /unexpected_http_status/);
  assert.match(oidcSpec, /changeOwnAvailability\(page:Page,targetStatus:"AVAILABLE"\|"OFFLINE"\)/);
  assert.match(oidcSpec, /restoreOwnAvailabilityOffline/);
  assert.match(externalInboxSource, /getByText\(\/Status:\\s\*Offline\\s\*·\\s\*0 de \\d\+ ativos\/u\)/);
  assert.doesNotMatch(externalInboxSource, /waitForResponse\([^\n]*request\(\)\.method\(\)==="GET"[^\n]*\/v1\/inbox\/availability/);
  assert.match(oidcSpec, /mutations\.filter\(value=>value==="POST \/v1\/inbox\/availability"\)\)\.toHaveLength\(2\)/);
  assert.doesNotMatch(safeDiagnosticSource, /console\.|\.text\(\)|correlationId|headers\(\)|url\(\)/);
  assert.doesNotMatch(oidcSource, /DATABASE_(?:URL|ADMIN_URL)/);
  assert.doesNotMatch(oidcSource, /sshpass|PreferredAuthentications=password|StrictHostKeyChecking=no/);
  assert.match(stagingReadme, /command="\/usr\/local\/sbin\/zap-pronto-staging-inbox-e2e-controller",restrict/);
  assert.match(stagingReadme, /inbox-e2e\.json`, proprietário `root:root` e modo `0400`/);
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
