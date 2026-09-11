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
  assert.equal(/eval|sh -c|bash -c/.test(source), false);
});

test("controller is valid POSIX shell when sh is available", { skip: process.platform === "win32" }, () => {
  const result = spawnSync("sh", ["-n", controller.pathname], { encoding:"utf8" });
  assert.equal(result.status, 0, result.stderr);
});
