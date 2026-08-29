import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
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

function gitOutput(cwd, args) {
  try {
    return execFileSync(process.platform === "win32" ? "git.exe" : "git", ["-C", cwd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Opt-in release identity gate. Normal local development may keep using
 * release:check without this gate; strict release evidence must not.
 */
export function validateGitReleaseState({ cwd = process.cwd(), baseRef = "origin/main" } = {}) {
  const branch = gitOutput(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) throw new Error("GIT_HEAD_DETACHED");
  const status = gitOutput(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status === undefined) throw new Error("GIT_REPOSITORY_REQUIRED");
  if (status.length > 0) throw new Error("GIT_WORKTREE_NOT_CLEAN");
  if (!gitOutput(cwd, ["rev-parse", "--verify", `${baseRef}^{commit}`])) {
    throw new Error("GIT_BASE_REF_REQUIRED");
  }
  const ancestor = spawnSync(process.platform === "win32" ? "git.exe" : "git",
    ["-C", cwd, "merge-base", "--is-ancestor", baseRef, "HEAD"], { stdio: "ignore", shell: false });
  if (ancestor.status !== 0) throw new Error("GIT_BASE_REF_NOT_ANCESTOR");
  return { branch, baseRef };
}

export function migrationHashes(directory = resolve("database/migrations")) {
  const entries = readdirSync(directory).sort();
  const malformed = entries.find((name) => /^\d{4}/.test(name) && !/^\d{4}_[a-z0-9_]+\.sql$/.test(name));
  if (malformed) throw new Error(`MIGRATION_FILENAME_INVALID:${malformed}`);
  const files = entries.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (files.length === 0) throw new Error("MIGRATION_SEQUENCE_EMPTY");
  for (const name of files) {
    if (!lstatSync(resolve(directory, name)).isFile()) throw new Error(`MIGRATION_ENTRY_NOT_REGULAR_FILE:${name}`);
  }
  const numbers = files.map((name) => Number.parseInt(name.slice(0, 4), 10));
  if (numbers.includes(0)) throw new Error("MIGRATION_SEQUENCE_ZERO_PREFIX:0000");
  const seen = new Set();
  for (const number of numbers) {
    if (seen.has(number)) throw new Error(`MIGRATION_SEQUENCE_DUPLICATE:${String(number).padStart(4, "0")}`);
    seen.add(number);
  }
  const latest = Math.max(...numbers);
  for (let number = 1; number <= latest; number += 1) {
    if (!seen.has(number)) throw new Error(`MIGRATION_SEQUENCE_GAP:${String(number).padStart(4, "0")}`);
  }
  return files.map((name) => ({ name, sha256: createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex") }));
}

function defaultRun(command, args, options) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runReleaseCheck({ env = process.env, cwd = process.cwd(), platform = process.platform,
  run = defaultRun, output = console.log, strictGit = false, baseRef = "origin/main" } = {}) {
  if (strictGit || env.RELEASE_REQUIRE_CLEAN_GIT === "1") validateGitReleaseState({ cwd, baseRef });
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
  const strictGit = process.argv.includes("--strict-git");
  const baseIndex = process.argv.indexOf("--base-ref");
  const baseRef = baseIndex >= 0 ? process.argv[baseIndex + 1] : "origin/main";
  try { runReleaseCheck({ strictGit, baseRef }); } catch (error) {
    console.error(error instanceof Error ? error.message : "RELEASE_CHECK_FAILED");
    process.exitCode = 1;
  }
}
