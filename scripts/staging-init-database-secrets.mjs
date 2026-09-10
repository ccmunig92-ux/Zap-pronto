import { randomBytes } from "node:crypto";
import { lstat, open, mkdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const DIRECTORY = "/srv/zap-pronto/secrets/staging";
export const FILES = Object.freeze([
  { name: "postgres-password", uid: 70, gid: 70 },
  { name: "database-migration-url", uid: 1000, gid: 1000 },
  { name: "database-runtime-url", uid: 1000, gid: 1000 },
  { name: "database-worker-url", uid: 1000, gid: 1000 },
]);

// Values never leave the VPS: no stdout, arguments, Git or environment secrets.
export function createDatabaseSecrets() {
  const owner = randomBytes(32).toString("hex");
  const runtime = randomBytes(32).toString("hex");
  const worker = randomBytes(32).toString("hex");
  const url = (role, password) => `postgresql://${role}:${password}@postgres:5432/zap_pronto`;
  return [owner, url("zap_pronto_owner", owner), url("zap_pronto_runtime", runtime),
    url("zap_pronto_worker_runtime", worker)];
}

export async function validateDirectory(directory) {
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("LINUX_ROOT_REQUIRED");
  let current = directory;
  while (true) {
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o022)) {
      throw new Error("UNSAFE_DIRECTORY");
    }
    if (current === directory && (metadata.mode & 0o777) !== 0o700) throw new Error("DIRECTORY_MODE_0700_REQUIRED");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function provisionDatabaseSecrets(directory = DIRECTORY) {
  await validateDirectory(directory);
  const lock = join(directory, ".database-secrets-init.lock");
  // Exclusive lock: concurrent runs must not mix owner/password bundles.
  await mkdir(lock, { mode: 0o700 });
  try {
    for (const file of FILES) {
      try { await lstat(join(directory, file.name)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      throw new Error("EXISTING_SECRETS_REFUSED");
    }
    const values = createDatabaseSecrets();
    for (const [index, file] of FILES.entries()) {
      const handle = await open(join(directory, file.name), "wx", 0o400);
      try {
        await handle.writeFile(values[index] + "\n", "utf8");
        await handle.chown(file.uid, file.gid);
        await handle.chmod(0o400);
        await handle.sync();
      } finally { await handle.close(); }
    }
  } finally {
    // Never remove generated files on error or rotate an existing database password.
    // Partial failure requires manual review; a retry refuses existing files.
    await rmdir(lock);
  }
}

if (process.argv[1] === "-" || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--apply") {
    console.error("Usage (VPS only): node staging-init-database-secrets.mjs --apply");
    process.exitCode = 1;
  } else {
    try {
      await provisionDatabaseSecrets();
      console.log("DATABASE_SECRET_FILES_CREATED; NO_DATABASE_STARTED; NO_MIGRATIONS_APPLIED");
    } catch {
      // Do not serialize errors or secret-bearing objects.
      console.error("DATABASE_SECRETS_INIT_FAILED: check Linux/root, directory ownership, existing files and lock. Do not delete existing secrets; partial files require review.");
      process.exitCode = 1;
    }
  }
}
