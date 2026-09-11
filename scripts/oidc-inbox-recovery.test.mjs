import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow=await readFile(new URL("../.github/workflows/oidc-homologation.yml",import.meta.url),"utf8");
const recoverySpec=await readFile(new URL("../apps/web/e2e/inbox-recovery-oidc.spec.ts",import.meta.url),"utf8");
const fixture=await readFile(new URL("./staging-inbox-e2e-fixture.mjs",import.meta.url),"utf8");

test("recovery performs canonical browser recovery before guarded SSH cleanup",()=>{
  const job=workflow.slice(workflow.indexOf("  recovery:"));
  const reactivate=job.indexOf("Recover dedicated attendant account");
  const browserRecovery=job.indexOf("Recover owned Inbox fixture and restore OFFLINE");
  const configureSsh=job.indexOf("Configure restricted staging fixture SSH for cleanup");
  const cleanup=job.indexOf("Cleanup isolated staging Inbox fixture");
  assert.ok(reactivate>=0&&reactivate<browserRecovery);
  assert.ok(browserRecovery<configureSsh&&configureSsh<cleanup);
  assert.match(job,/inbox-recovery-oidc\.spec\.ts/);
  assert.match(job,/if: \$\{\{ always\(\) && steps\.fixture_ssh\.outcome == 'success' \}\}/);
});

test("browser recovery targets only the deterministic fixture and never takes over or transfers",()=>{
  assert.match(recoverySpec,/const contactName=`E2E Inbox \$\{runKey\}`/);
  assert.match(recoverySpec,/getByRole\("button",\{name:`\$\{contactName\} · Em atendimento`\}\)/);
  assert.match(recoverySpec,/name:"Devolver à fila"/);
  assert.match(recoverySpec,/pathname\.endsWith\("\/requeue"\)/);
  assert.match(recoverySpec,/responseStatus\(requeue\)\)\.toBe\(200\)/);
  assert.match(recoverySpec,/selectOption\("OFFLINE"\)/);
  assert.doesNotMatch(recoverySpec,/getByRole\([^\n]+Assumir atendimento/);
  assert.doesNotMatch(recoverySpec,/\.click\([^\n]*(?:takeover|transfer)|fetch\([^\n]*(?:takeover|transfer)/i);
});

test("fixture cleanup refuses active or assigned work before its first DELETE",()=>{
  const guard=fixture.indexOf("async function assertFixtureCleanupSafe");
  const deletion=fixture.indexOf("async function deleteFixtureRows");
  const firstDelete=fixture.indexOf("DELETE FROM",deletion);
  assert.ok(guard>=0&&guard<deletion&&deletion<firstDelete);
  assert.match(fixture,/SELECT status,assigned_user_id FROM human_handoffs[\s\S]*FOR UPDATE/);
  assert.match(fixture,/SELECT assigned_user_id FROM conversations[\s\S]*FOR UPDATE/);
  assert.match(fixture,/handoffRow\?\.status === "ACTIVE" \|\| handoffRow\?\.assigned_user_id != null/);
  assert.match(fixture,/conversationRow\?\.assigned_user_id != null/);
  assert.match(fixture,/handoff_transfer_commands[\s\S]*transfer_exists/);
  assert.match(fixture,/handoff_takeover_commands[\s\S]*takeover_exists/);
  assert.match(fixture,/FIXTURE_CLEANUP_ACTIVE_WORK_CONFLICT/);
  assert.match(fixture,/async function deleteFixtureRows[\s\S]*?await assertFixtureCleanupSafe\(client, config, fixture\);[\s\S]*?DELETE FROM/);
});
