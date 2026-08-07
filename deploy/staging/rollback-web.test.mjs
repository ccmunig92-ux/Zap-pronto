import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("./rollback-web.sh", import.meta.url);
const source = await readFile(scriptUrl, "utf8");

test("rollback requires immutable current and target images from the same repository", () => {
  assert.match(source, /PREVIOUS_WEB_IMAGE_IMMUTABLE_DIGEST_REQUIRED/);
  assert.match(source, /CURRENT_WEB_IMAGE_IMMUTABLE_DIGEST_REQUIRED/);
  assert.match(source, /current_repository=\$\{current_image%@sha256:\*\}/);
  assert.match(source, /WEB_ROLLBACK_REPOSITORY_MISMATCH/);
});

test("rollback takes a non-blocking exclusive host lock before mutating web", () => {
  const lock = source.indexOf("flock -n 9");
  const pull = source.indexOf('docker pull "$target_image"');
  assert.ok(lock >= 0);
  assert.ok(pull > lock);
  assert.match(source, /exec 9<"\$env_file"/);
  assert.match(source, /WEB_ROLLBACK_ALREADY_RUNNING/);
});

test("failed rollback restores and verifies the exact previous digest", () => {
  assert.match(source, /verify_image "\$current_image"/);
  assert.match(source, /WEB_ROLLBACK_RESTORE_FAILED_HIGH/);
  assert.match(source, /WEB_ROLLBACK_RESTORE_VERIFICATION_FAILED_HIGH/);
  assert.match(source, /WEB_ACTIVE_IMAGE_MISMATCH/);
  assert.doesNotMatch(source, /compose up[^\n]+\|\| true/);
});

test("target provenance is verified before the image is pulled", () => {
  const verify = source.indexOf('gh attestation verify "oci://$target_image"');
  const pull = source.indexOf('docker pull "$target_image"');
  assert.ok(verify > 0 && verify < pull);
  assert.match(source, /--signer-workflow/);
  assert.match(source, /--deny-self-hosted-runners/);
});
