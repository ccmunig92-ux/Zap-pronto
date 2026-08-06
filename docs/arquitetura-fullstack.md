# Arquitetura full-stack canônica

Fluxo único e obrigatório:

`apps/web -> cliente gerado do OpenAPI -> apps/api -> autenticação/RBAC -> withTenantTransaction -> domínio -> PostgreSQL`

## Responsabilidades

- `src/domain` e `src/database`: núcleo canônico; nenhuma regra é duplicada em API ou frontend.
- `packages/contracts`: schemas públicos que validam HTTP e geram OpenAPI.
- `apps/api`: composição Fastify, identidade substituível, autorização, rotas e tratamento de erros.
- `apps/web`: console operacional; nunca acessa banco ou aceita tenant como fonte de verdade.
- `packages/api-client`: será criado por geração automática após estabilizar o OpenAPI e a matriz IDOR.

O frontend não implementa autorização: seus guards servem apenas para experiência do usuário. A API
resolve a identidade persistida, tenant, unidades e permissões e abre a transação tenant-aware. Handlers
não executam SQL e não reimplementam casos de uso.

## Sequência da Fase 3

1. Identidade OIDC persistida, convites, revogação e auditoria correlacionada.
2. Contexto HTTP, Problem Details, autenticação e política central de permissões.
3. Matriz automatizada de RBAC e IDOR com dois tenants e duas unidades.
4. `/v1/me`, unidades e rotas administrativas mínimas.
5. OpenAPI determinístico e cliente TypeScript gerado.
6. Shell autenticado do frontend consumindo exclusivamente o cliente gerado.

Não criar BFF, GraphQL paralelo, acesso Supabase direto, DTO manual duplicado ou microserviço de auth.
