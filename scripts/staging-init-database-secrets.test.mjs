import test from "node:test";
import assert from "node:assert/strict";
import { createDatabaseSecrets, FILES, provisionDatabaseSecrets } from "./staging-init-database-secrets.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, stat, unlink, rmdir, symlink } from "node:fs/promises";
import { join } from "node:path";

test("owner URL uses the same random password as Postgres; roles and database are canonical", () => {
  const values = createDatabaseSecrets();
  assert.match(values[0], /^[a-f0-9]{64}$/);
  const urls = values.slice(1).map((value) => new URL(value));
  assert.equal(urls[0].password, values[0]);
  assert.deepEqual(urls.map((url) => url.username), ["zap_pronto_owner", "zap_pronto_runtime", "zap_pronto_worker_runtime"]);
  for (const url of urls) {
    assert.equal(url.hostname, "postgres");
    assert.equal(url.port, "5432");
    assert.equal(url.pathname, "/zap_pronto");
    assert.match(url.password, /^[a-f0-9]{64}$/);
  }
  assert.equal(new Set(urls.map((url) => url.password)).size, 3);
});

test("each invocation produces independent credentials", () => {
  assert.notDeepEqual(createDatabaseSecrets(), createDatabaseSecrets());
});

test("ownership matches canonical container users and excludes fabricated Meta secrets", () => {
  assert.deepEqual(FILES.map(({uid,gid}) => [uid,gid]), [[70,70],[1000,1000],[1000,1000],[1000,1000]]);
  assert.equal(FILES.length, 4);
  assert.ok(FILES.every(({name}) => !name.includes("meta")));
});

test("CLI refuses to create files without explicit apply", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./staging-init-database-secrets.mjs", import.meta.url))], {encoding:"utf8"});
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("non-root or non-Linux execution fails before writing", {skip:process.platform === "linux" && process.getuid?.() === 0}, async () => {
  await assert.rejects(provisionDatabaseSecrets(), /LINUX_ROOT_REQUIRED/);
});

test("Linux provisioning enforces ownership, preserves existing files and rejects symlinks", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, async () => {
  // Isolated fixture in a trusted root-owned parent; never the staging directory.
  const directory = await mkdtemp("/root/zap-pronto-secret-test-");
  const alias = directory + "-link";
  try {
    await provisionDatabaseSecrets(directory);
    const before = [];
    for (const file of FILES) {
      const path = join(directory, file.name);
      const metadata = await stat(path);
      assert.equal(metadata.mode & 0o777, 0o400);
      assert.equal(metadata.uid, file.uid);
      assert.equal(metadata.gid, file.gid);
      before.push(await readFile(path, "utf8"));
    }
    await assert.rejects(provisionDatabaseSecrets(directory), /EXISTING_SECRETS_REFUSED/);
    for (const [index, file] of FILES.entries()) {
      assert.equal(await readFile(join(directory, file.name), "utf8"), before[index]);
    }
    await symlink(directory, alias);
    await assert.rejects(provisionDatabaseSecrets(alias), /UNSAFE_DIRECTORY/);
  } finally {
    await unlink(alias).catch((error) => { if (error.code !== "ENOENT") throw error; });
    for (const file of FILES) await unlink(join(directory, file.name)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
});
