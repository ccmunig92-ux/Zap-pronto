import test from "node:test";
import assert from "node:assert/strict";
import { latestMigrationNumber, validateDocumentation } from "./check-docs-consistency.mjs";

const current = {
  latest: 80,
  readme: "O candidato local contém uma Inbox validada até a migration `0080`.",
  release: "O checkpoint `0080` está presente no candidato local.",
  schedule: "O estado inclui migrations `0068`–`0080` no mesmo monólito.",
};

test("deriva o checkpoint mais recente dos nomes das migrations", () => {
  assert.equal(latestMigrationNumber(["0001_core.sql", "0067_old.sql", "0080_new.sql", "README.md"]), 80);
});

test("aceita documentação alinhada ao checkpoint atual", () => {
  assert.deepEqual(validateDocumentation(current).declarations, { README: 80, release: 80, "release-status": 80 });
});

test("rejeita declaração obsoleta de checkpoint 0067", () => {
  assert.throws(() => validateDocumentation({ ...current, release: current.release.replaceAll("0080", "0067") }), /DOCUMENTATION_CHECKPOINT_STALE/);
});

test("rejeita intervalo de increments ausente", () => {
  assert.throws(() => validateDocumentation({ ...current, schedule: "migrations `0067`" }), /DOCUMENTATION_INCREMENT_RANGE_MISSING/);
});
