# Arquitetura full-stack canônica

Fluxo único e obrigatório:

`apps/web -> cliente gerado do OpenAPI -> apps/api -> autenticação/RBAC -> withTenantTransaction -> domínio -> PostgreSQL`

## Responsabilidades

- `src/domain` e `src/database`: núcleo canônico; nenhuma regra é duplicada em API ou frontend.
- `packages/contracts`: schemas públicos que validam HTTP e geram OpenAPI.
- `apps/api`: composição Fastify, identidade substituível, autorização, rotas e tratamento de erros.
- `apps/web`: console operacional; nunca acessa banco ou aceita tenant como fonte de verdade.
- `packages/api-client`: cliente gerado e verificado a partir do OpenAPI; o frontend não cria DTOs ou
  chamadas HTTP paralelas.

O frontend não implementa autorização: seus guards servem apenas para experiência do usuário. A API
resolve a identidade persistida, tenant, unidades e permissões e abre a transação tenant-aware. Handlers
não executam SQL e não reimplementam casos de uso.

## Sequência da Fase 3

1. Identidade OIDC persistida, convites, revogação e auditoria correlacionada.
2. Contexto HTTP, Problem Details, autenticação e política central de permissões.
3. Matriz automatizada de RBAC e IDOR com dois tenants e duas unidades.
4. `/v1/me` integrado e fail-closed; depois unidades e rotas administrativas mínimas.
5. OpenAPI determinístico e cliente TypeScript gerado, com verificação de drift.
6. Shell autenticado do frontend consumindo exclusivamente o cliente gerado; o provedor OIDC real
   permanece um gate de runtime, não um token simulado no frontend.

Não criar BFF, GraphQL paralelo, acesso Supabase direto, DTO manual duplicado ou microserviço de auth.

## Boundary do primeiro inbox humano

O inbox não cria um segundo modelo de conversa ou fila. A projeção de leitura parte de
`human_handoffs` e seus vínculos tenant-aware com conversa, caso e unidade. O claim reutiliza o agregado
e as transições existentes; API e frontend não atualizam status diretamente.

Fluxo obrigatório quando o gate OIDC externo liberar a Fase 4:

`cliente OpenAPI -> protectedRoute(handoff.*, unit) -> transação autenticada/RLS -> domínio handoffs -> PostgreSQL`

A unidade pedida para listar pode vir da query apenas como identificador de recurso e precisa ser
autorizada pelo banco. No claim, a unidade deve ser derivada do próprio handoff, nunca repetida no body.
O estado de automação da conversa é a autoridade para o takeover: `HUMAN_REQUESTED`, `HUMAN_QUEUED`,
`HUMAN_ACTIVE` e `SUSPENDED` proíbem resposta Hermes. Ocultar o composer no frontend não constitui essa
garantia; o futuro comando outbound deve revalidar o estado na mesma transação da gravação da mensagem.

O corte inicial cobre apenas listagem e claim. Transferência, devolução, encerramento, presença, SLA
operacional, produtividade e realtime permanecem incrementos posteriores sobre o mesmo agregado.
