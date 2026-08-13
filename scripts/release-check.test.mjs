import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("hashes cobrem todas as migrations contíguas até a maior presente", () => {
  const hashes=migrationHashes();
  const files=readdirSync(new URL("../database/migrations/",import.meta.url))
    .filter(name=>/^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  assert.deepEqual(hashes.map(item=>item.name),files);
  assert.match(hashes[0].name,/^0001_/);
  assert.equal(Number.parseInt(hashes.at(-1).name.slice(0,4),10),hashes.length);
  for(const item of hashes)assert.match(item.sha256,/^[a-f0-9]{64}$/);
});

test("hashes acompanham automaticamente uma nova migration contígua", () => {
  const directory=mkdtempSync(join(tmpdir(),"zap-pronto-migrations-"));
  try {
    writeFileSync(join(directory,"0001_first.sql"),"SELECT 1;\n");
    writeFileSync(join(directory,"0002_second.sql"),"SELECT 2;\n");
    writeFileSync(join(directory,"0003_third.sql"),"SELECT 3;\n");
    const hashes=migrationHashes(directory);
    assert.deepEqual(hashes.map(item=>item.name),["0001_first.sql","0002_second.sql","0003_third.sql"]);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test("hashes rejeitam gap e prefixo duplicado", () => {
  const gap=mkdtempSync(join(tmpdir(),"zap-pronto-migrations-gap-"));
  const duplicate=mkdtempSync(join(tmpdir(),"zap-pronto-migrations-duplicate-"));
  try {
    writeFileSync(join(gap,"0001_first.sql"),"SELECT 1;\n");
    writeFileSync(join(gap,"0003_third.sql"),"SELECT 3;\n");
    assert.throws(()=>migrationHashes(gap),/MIGRATION_SEQUENCE_GAP:0002/);
    writeFileSync(join(duplicate,"0001_first.sql"),"SELECT 1;\n");
    writeFileSync(join(duplicate,"0001_again.sql"),"SELECT 1;\n");
    assert.throws(()=>migrationHashes(duplicate),/MIGRATION_SEQUENCE_DUPLICATE:0001/);
  } finally {
    rmSync(gap,{recursive:true,force:true});
    rmSync(duplicate,{recursive:true,force:true});
  }
});

test("hashes rejeitam prefixo zero e filename numerado malformado", () => {
  const zero=mkdtempSync(join(tmpdir(),"zap-pronto-migrations-zero-"));
  const malformed=mkdtempSync(join(tmpdir(),"zap-pronto-migrations-malformed-"));
  try {
    writeFileSync(join(zero,"0000_zero.sql"),"SELECT 0;\n");
    writeFileSync(join(zero,"0001_first.sql"),"SELECT 1;\n");
    assert.throws(()=>migrationHashes(zero),/MIGRATION_SEQUENCE_ZERO_PREFIX:0000/);
    writeFileSync(join(malformed,"0001_first.sql"),"SELECT 1;\n");
    writeFileSync(join(malformed,"0002-Bad.sql"),"SELECT 2;\n");
    assert.throws(()=>migrationHashes(malformed),/MIGRATION_FILENAME_INVALID:0002-Bad\.sql/);
  } finally {
    rmSync(zero,{recursive:true,force:true});
    rmSync(malformed,{recursive:true,force:true});
  }
});

test("hashes ignoram auxiliares não numerados e rejeitam entrada canônica não regular", () => {
  const auxiliary=mkdtempSync(join(tmpdir(),"zap-pronto-migrations-auxiliary-"));
  const directoryEntry=mkdtempSync(join(tmpdir(),"zap-pronto-migrations-directory-"));
  const symlinkEntry=mkdtempSync(join(tmpdir(),"zap-pronto-migrations-symlink-"));
  try {
    writeFileSync(join(auxiliary,"0001_first.sql"),"SELECT 1;\n");
    writeFileSync(join(auxiliary,"README.md"),"auxiliary\n");
    writeFileSync(join(auxiliary,"helper.sql"),"SELECT 2;\n");
    assert.deepEqual(migrationHashes(auxiliary).map(item=>item.name),["0001_first.sql"]);
    mkdirSync(join(directoryEntry,"0001_directory.sql"));
    assert.throws(()=>migrationHashes(directoryEntry),/MIGRATION_ENTRY_NOT_REGULAR_FILE:0001_directory\.sql/);
    writeFileSync(join(symlinkEntry,"target.sql"),"SELECT 1;\n");
    symlinkSync(join(symlinkEntry,"target.sql"),join(symlinkEntry,"0001_link.sql"),"file");
    assert.throws(()=>migrationHashes(symlinkEntry),/MIGRATION_ENTRY_NOT_REGULAR_FILE:0001_link\.sql/);
  } finally {
    rmSync(auxiliary,{recursive:true,force:true});
    rmSync(directoryEntry,{recursive:true,force:true});
    rmSync(symlinkEntry,{recursive:true,force:true});
  }
});
