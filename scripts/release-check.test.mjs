import assert from "node:assert/strict";
import test from "node:test";
import { migrationHashes, releaseGatePlan, runReleaseCheck, validateAdminDatabaseUrl } from "./release-check.mjs";

test("preflight aceita apenas PostgreSQL local e não retorna segredo", () => {
  assert.deepEqual(validateAdminDatabaseUrl("postgresql://owner:never-print@127.0.0.1:5432/postgres"),
    { database: "postgres", host: "127.0.0.1" });
  for (const value of [undefined, "bad", "postgresql://u:p@db.internal/postgres",
    "postgresql://u:p@localhost/zap_pronto_production", "postgresql://u:p@localhost/staging"])
    assert.throws(() => validateAdminDatabaseUrl(value), /DATABASE_ADMIN_URL/);
});

test("plano contém uma única sequência canônica e fail-fast", () => {
  const plan = releaseGatePlan("win32");
  assert.deepEqual(plan.map(([, args]) => args.join(" ")), ["/d /s /c pnpm.cmd test:all", "/d /s /c pnpm.cmd typecheck:all", "/d /s /c pnpm.cmd api:check", "/d /s /c pnpm.cmd build:all",
    "/d /s /c pnpm.cmd db:test", "/d /s /c pnpm.cmd db:test:upgrade", "--test deploy/local-oidc/overlay.test.mjs",
    "-NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Verify",
    "-NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action E2E", "diff --check"]);
  const calls = [], output = [];
  assert.throws(() => runReleaseCheck({ env:{DATABASE_ADMIN_URL:"postgres://u:top-secret@localhost/postgres"},
    platform:"win32", run(command,args){calls.push([command,args]);return calls.length===3?2:0;}, output:value=>output.push(value) }),
  /RELEASE_GATE_FAILED:\/d/);
  assert.equal(calls.length,3);
  assert.equal(output.join("\n").includes("top-secret"),false);
});

test("hashes cobrem exatamente migrations 0001-0050", () => {
  const hashes=migrationHashes();
  assert.equal(hashes.length,50);
  assert.match(hashes[0].name,/^0001_/);assert.match(hashes[49].name,/^0050_/);
  for(const item of hashes)assert.match(item.sha256,/^[a-f0-9]{64}$/);
});
