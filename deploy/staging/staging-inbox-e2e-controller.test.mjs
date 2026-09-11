import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const controller = new URL("./staging-inbox-e2e-controller.sh", import.meta.url);

test("controller exposes only the three fixture actions through a forced SSH command", async () => {
  const source = await readFile(controller, "utf8");
  assert.match(source, /SSH_ORIGINAL_COMMAND/);
  assert.match(source, /prepare\|verify\|cleanup/);
  assert.match(source, /\*\[!0-9-\]\*/);
  assert.match(source, /--no-deps --user 0:0/);
  assert.match(source, /INBOX_E2E_CONFIG_FILE=\/run\/secrets\/inbox_e2e_config/);
  assert.match(source, /stat -c '%u:%a'/);
  assert.match(source, /MIGRATION_SECRET_FILE=\/srv\/zap-pronto\/secrets\/staging\/database-migration-url/);
  assert.match(source, /stat -c '%u:%g:%a' "\$MIGRATION_SECRET_FILE"\)" = "1000:1000:400"/);
  assert.match(source, /install -d -o root -g root -m 0700 "\$RUNTIME_DIRECTORY"/);
  assert.match(source, /\[ ! -L "\$RUNTIME_DIRECTORY" \] \|\| fail/);
  assert.match(source, /stat -c '%u:%g:%a' "\$RUNTIME_DIRECTORY"\)" = "0:0:700"/);
  assert.match(source, /temporary_migration_secret=\$\(mktemp "\$RUNTIME_DIRECTORY\/database-migration-url\.XXXXXX"\)/);
  assert.match(source, /install -o root -g root -m 0400 "\$MIGRATION_SECRET_FILE" "\$temporary_migration_secret"/);
  assert.match(source, /stat -c '%u:%g:%a' "\$temporary_migration_secret"\)" = "0:0:400"/);
  assert.match(source, /trap cleanup 0/);
  assert.match(source, /trap 'exit 129' HUP/);
  assert.match(source, /trap 'exit 130' INT/);
  assert.match(source, /trap 'exit 143' TERM/);
  assert.match(source, /rm -f -- "\$temporary_migration_secret"/);
  assert.match(source, /-v "\$temporary_migration_secret:\/run\/secrets\/database_migration_url:ro"/);
  assert.doesNotMatch(source, /exec docker compose/);
  assert.doesNotMatch(source, /(?:cat|echo|printf).*MIGRATION_SECRET_FILE/);
  assert.equal(/eval|sh -c|bash -c/.test(source), false);
});

test("controller is valid POSIX shell when sh is available", { skip: process.platform === "win32" }, () => {
  const result = spawnSync("sh", ["-n", controller.pathname], { encoding:"utf8" });
  assert.equal(result.status, 0, result.stderr);
});
