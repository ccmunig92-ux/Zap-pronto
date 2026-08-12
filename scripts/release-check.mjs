import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const FORBIDDEN_DATABASE = /(^|[_-])(prod|production|staging|live)([_-]|$)/i;

export function validateAdminDatabaseUrl(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("DATABASE_ADMIN_URL_REQUIRED");
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("DATABASE_ADMIN_URL_INVALID"); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error("DATABASE_ADMIN_URL_LOCAL_REQUIRED");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!database || FORBIDDEN_DATABASE.test(database)) throw new Error("DATABASE_ADMIN_URL_DATABASE_FORBIDDEN");
  return { database, host: parsed.hostname };
}

export function releaseGatePlan(platform = process.platform) {
  const packageGate = (script) => platform === "win32"
    ? [process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "pnpm.cmd", script]]
    : ["pnpm", [script]];
  const git = platform === "win32" ? "git.exe" : "git";
  const powershell = platform === "win32" ? "pwsh.exe" : "pwsh";
  return [
    packageGate("test:all"),
    packageGate("typecheck:all"),
    packageGate("api:check"),
    packageGate("build:all"),
    packageGate("db:test"),
    packageGate("db:test:upgrade"),
    [process.execPath, ["--test", "deploy/local-oidc/overlay.test.mjs"]],
    [powershell, ["-NoProfile", "-File", "deploy/local-oidc/local-oidc.ps1", "-Action", "Verify"]],
    [powershell, ["-NoProfile", "-File", "deploy/local-oidc/local-oidc.ps1", "-Action", "E2E"]],
    [git, ["diff", "--check"]],
  ];
}

export function migrationHashes(directory = resolve("database/migrations")) {
  const files = readdirSync(directory).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const expected = Array.from({ length: 50 }, (_, index) => String(index + 1).padStart(4, "0"));
  const selected = files.filter((name) => name.slice(0, 4) <= "0050");
  if (selected.length !== expected.length || selected.some((name, index) => !name.startsWith(`${expected[index]}_`))) {
    throw new Error("MIGRATION_SEQUENCE_0001_0050_INVALID");
  }
  return selected.map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex") }));
}

function defaultRun(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runReleaseCheck({ env = process.env, cwd = process.cwd(), platform = process.platform,
  run = defaultRun, output = console.log } = {}) {
  validateAdminDatabaseUrl(env.DATABASE_ADMIN_URL);
  for (const [command, args] of releaseGatePlan(platform)) {
    output(`[release:check] ${args.join(" ")}`);
    const status = run(command, args, { cwd, env });
    if (status !== 0) throw new Error(`RELEASE_GATE_FAILED:${args[0] ?? command}`);
  }
  const hashes = migrationHashes(resolve(cwd, "database/migrations"));
  for (const hash of hashes) output(`${hash.sha256}  database/migrations/${hash.name}`);
  return { gates: releaseGatePlan(platform).length, migrations: hashes.length };
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try { runReleaseCheck(); } catch (error) {
    console.error(error instanceof Error ? error.message : "RELEASE_CHECK_FAILED");
    process.exitCode = 1;
  }
}
