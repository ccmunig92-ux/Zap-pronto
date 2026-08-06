import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  withTenantTransaction,
  type TenantTransactionPool,
} from "./tenant-transaction.js";

const context = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000002",
  correlationId: "request-12345678",
};

function fakePool(log: string[], failOnQuery?: string): TenantTransactionPool {
  return {
    async connect() {
      return {
        async query(query: string) {
          const normalized = query.replace(/\s+/g, " ").trim();
          log.push(normalized);
          if (normalized === failOnQuery) throw new Error(`${normalized}_FAILED`);
          return {};
        },
        release(error?: Error | boolean) {
          log.push(error ? "RELEASE_DESTROYED" : "RELEASE");
        },
      };
    },
  };
}

describe("withTenantTransaction", () => {
  test("aplica role e contexto somente dentro da transação", async () => {
    const log: string[] = [];
    const result = await withTenantTransaction(fakePool(log), context, async () => {
      log.push("OPERATION");
      return "ok";
    });

    assert.equal(result, "ok");
    assert.deepEqual(log, [
      "BEGIN",
      "SET LOCAL ROLE zap_pronto_app",
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.correlation_id', $3, true)",
      "SELECT assert_app_context_authorized()",
      "OPERATION",
      "COMMIT",
      "RELEASE",
    ]);
  });

  test("faz rollback e libera a conexão quando o caso de uso falha", async () => {
    const log: string[] = [];

    await assert.rejects(
      withTenantTransaction(fakePool(log), context, async () => {
        throw new Error("OPERATION_FAILED");
      }),
      /OPERATION_FAILED/,
    );

    assert.deepEqual(log.slice(-2), ["ROLLBACK", "RELEASE"]);
    assert.ok(!log.includes("COMMIT"));
  });

  test("rejeita contexto inválido antes de obter uma conexão", async () => {
    let connected = false;
    const pool: TenantTransactionPool = {
      async connect() {
        connected = true;
        return fakePool([]).connect();
      },
    };

    await assert.rejects(
      withTenantTransaction(pool, { ...context, tenantId: "do-corpo-da-requisicao" }, async () => undefined),
      /INVALID_TENANT_ID/,
    );
    assert.equal(connected, false);
  });

  test("destrói a conexão quando o rollback falha", async () => {
    const log: string[] = [];

    await assert.rejects(
      withTenantTransaction(fakePool(log, "ROLLBACK"), context, async () => {
        throw new Error("OPERATION_FAILED");
      }),
      /OPERATION_FAILED/,
    );

    assert.deepEqual(log.slice(-2), ["ROLLBACK", "RELEASE_DESTROYED"]);
  });
});
