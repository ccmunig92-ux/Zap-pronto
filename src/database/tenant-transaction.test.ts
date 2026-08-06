import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  withAuthenticatedTenantTransaction,
  withTenantTransaction,
  type TenantTransactionPool,
} from "./tenant-transaction.js";

const context = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000002",
  correlationId: "request-12345678",
};

function fakePool(
  log: string[],
  failOnQuery?: string,
  resolvedRows: unknown[] = [],
): TenantTransactionPool {
  return {
    async connect() {
      return {
        async query(query: string, values?: unknown[]) {
          const normalized = query.replace(/\s+/g, " ").trim();
          log.push(normalized);
          if (normalized === failOnQuery) throw new Error(`${normalized}_FAILED`);
          if (normalized.startsWith("SELECT tenant_id, user_id FROM resolve_oidc_principal")) {
            log.push(`OIDC_VALUES:${JSON.stringify(values)}`);
            return { rows: resolvedRows };
          }
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
      "SET LOCAL ROLE zap_pronto_api",
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

describe("withAuthenticatedTenantTransaction", () => {
  const principal = {
    issuer: "https://identity.example.com",
    audience: "zap-pronto",
    subject: "subject-123",
    organizationClaim: "org_id",
    organizationValue: "clinic-a",
    correlationId: "request-oidc-12345678",
  };

  test("resolve OIDC, instala o contexto derivado e executa tudo na mesma transação", async () => {
    const log: string[] = [];
    const result = await withAuthenticatedTenantTransaction(
      fakePool(log, undefined, [{
        tenant_id: context.tenantId,
        user_id: context.actorId,
      }]),
      principal,
      async () => {
        log.push("OPERATION");
        return "ok";
      },
    );

    assert.equal(result, "ok");
    assert.deepEqual(log, [
      "BEGIN",
      "SET LOCAL ROLE zap_pronto_api",
      "SELECT tenant_id, user_id FROM resolve_oidc_principal($1, $2, $3, $4, $5)",
      `OIDC_VALUES:${JSON.stringify([principal.issuer, principal.audience, principal.subject, principal.organizationClaim, principal.organizationValue])}`,
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_id', $2, true), set_config('app.correlation_id', $3, true)",
      "SELECT assert_app_context_authorized()",
      "OPERATION",
      "COMMIT",
      "RELEASE",
    ]);
  });

  test("nega resolução vazia antes da operação e faz rollback", async () => {
    const log: string[] = [];
    let operated = false;

    await assert.rejects(
      withAuthenticatedTenantTransaction(fakePool(log), principal, async () => {
        operated = true;
      }),
      /AUTH_UNAUTHORIZED/,
    );

    assert.equal(operated, false);
    assert.deepEqual(log.slice(-2), ["ROLLBACK", "RELEASE"]);
    assert.ok(!log.some((entry) => entry.includes("set_config")));
  });

  test("rejeita organização incompleta antes de obter conexão", async () => {
    let connected = false;
    const pool: TenantTransactionPool = {
      async connect() {
        connected = true;
        return fakePool([]).connect();
      },
    };

    await assert.rejects(
      withAuthenticatedTenantTransaction(
        pool,
        {
          issuer: principal.issuer,
          audience: principal.audience,
          subject: principal.subject,
          organizationClaim: principal.organizationClaim,
          correlationId: principal.correlationId,
        },
        async () => undefined,
      ),
      /INVALID_OIDC_ORGANIZATION/,
    );
    assert.equal(connected, false);
  });

  test("nega principal resolvido com identificadores inválidos e faz rollback", async () => {
    const log: string[] = [];

    await assert.rejects(
      withAuthenticatedTenantTransaction(
        fakePool(log, undefined, [{ tenant_id: "tenant-invalido", user_id: context.actorId }]),
        principal,
        async () => undefined,
      ),
      /INVALID_TENANT_ID/,
    );

    assert.deepEqual(log.slice(-2), ["ROLLBACK", "RELEASE"]);
  });
});
