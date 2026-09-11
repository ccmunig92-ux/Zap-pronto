import test from "node:test";
import assert from "node:assert/strict";
import { latestMigrationNumber, validateDocumentation } from "./check-docs-consistency.mjs";

const current = {
  latest: 79,
  readme: "O candidato local contém uma Inbox validada até a migration `0079`; ainda não está na main.",
  release: "O checkpoint `0079` está presente no candidato. A declaração permitida é **checkpoint 0079 presente no candidato local**.",
  schedule: "O estado inclui migrations `0068`–`0079` no mesmo monólito.",
};

test("deriva o checkpoint mais recente dos nomes das migrations", () => {
  assert.equal(latestMigrationNumber(["0001_core.sql", "0067_old.sql", "0079_new.sql", "README.md"]), 79);
});

test("aceita documentação alinhada ao checkpoint atual", () => {
  assert.deepEqual(validateDocumentation(current).declarations, { README: 79, release: 79, "release-candidate": 79 });
});

test("rejeita declaração obsoleta de checkpoint 0067", () => {
  assert.throws(() => validateDocumentation({ ...current, release: current.release.replaceAll("0079", "0067") }), /DOCUMENTATION_CHECKPOINT_STALE/);
});

test("rejeita intervalo de increments ausente", () => {
  assert.throws(() => validateDocumentation({ ...current, schedule: "migrations `0067`" }), /DOCUMENTATION_INCREMENT_RANGE_MISSING/);
});
