# ADR 003 — limite do contexto de tenant

## Decisão

A RLS é defesa em profundidade contra consultas incorretas. Ela não substitui autenticação.

O `tenantId` usado por `withTenantTransaction` deve ser derivado da identidade autenticada e da associação persistida do usuário. IDs enviados em path, query ou body nunca definem o tenant ativo.

Cada caso de uso executa uma única transação:

1. `BEGIN`;
2. `SET LOCAL ROLE zap_pronto_app`;
3. definição parametrizada de tenant, ator e correlation ID;
4. validação de que o ator está ativo no tenant;
5. operações do caso de uso;
6. `COMMIT` ou `ROLLBACK`;
7. devolução da conexão ao pool.

`SET LOCAL` impede que o contexto sobreviva ao fim da transação e contamine outra requisição no pool.

## Limite de ameaça

Uma credencial compartilhada de banco não impede que uma aplicação totalmente comprometida escolha outro tenant. Esse risco será reduzido pela validação OIDC, membership no servidor, menor privilégio, segregação de papéis, auditoria e ausência de SQL arbitrário na API.
