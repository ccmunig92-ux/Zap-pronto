# Banco próprio

PostgreSQL é a fonte de verdade. Sistemas externos são integrações opcionais.

- Toda tabela operacional contém `tenant_id`.
- FKs compostas impedem referências entre tenants.
- Valores monetários usam centavos inteiros.
- Mensagens, handoffs e eventos possuem idempotência.
- Segredos reais ficam em cofre; o banco guarda somente a referência.
- Migrations aplicadas são imutáveis.

## Contexto obrigatório

Cada transação da aplicação deve executar:

```sql
BEGIN;
SET LOCAL ROLE zap_pronto_api;
SELECT
  set_config('app.tenant_id', '<tenant-uuid>', true),
  set_config('app.actor_id', '<actor-uuid>', true),
  set_config('app.correlation_id', '<correlation-id>', true);
SELECT assert_app_context_authorized();
-- operações do caso de uso
COMMIT;
```

Nunca use o papel `postgres` na aplicação. Ele é superusuário e ignora RLS. A API assume `zap_pronto_api`; processadores assíncronos usam uma credencial separada com membership exclusiva em `zap_pronto_worker`.

## Executor de migrations

Configure `DATABASE_URL` apenas no ambiente e execute `pnpm db:migrate`. O executor:

- ordena migrations pelo nome;
- usa advisory lock contra execução concorrente;
- registra SHA-256 em `schema_migrations`;
- interrompe se uma migration aplicada tiver sido alterada.
