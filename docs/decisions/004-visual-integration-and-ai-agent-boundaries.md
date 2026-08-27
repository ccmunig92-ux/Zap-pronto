# ADR 004 — Integração visual e fronteiras dos agentes de IA

## Status

Aceita para implementação incremental. Não autoriza deploy, conexão de contas reais ou acesso do Hermes a segredos.

## Problema

O protótipo visual `ccmunig92-ux/august-wonder-plan` contém layouts úteis, mas também introduz sessão, cliente HTTP, modelos e operações simuladas paralelas ao fluxo canônico. Copiar esse código integralmente quebraria as garantias de autenticação, autorização, isolamento por tenant, idempotência e concorrência já implementadas no Zap-pronto.

## Decisão

Somente JSX apresentacional, tokens visuais e padrões de acessibilidade podem ser adaptados do protótipo. O runtime permanece composto por:

```text
apps/web (intenção e apresentação)
  -> apps/web/src/api.ts
  -> @zap-pronto/api-client
  -> API protegida e contratos OpenAPI
  -> domínio tenant-aware e RLS
  -> outbox/workers
  -> Tool Gateway estreito
  -> Hermes
```

São proibidos no artefato integrado:

- cliente HTTP alternativo;
- sessão ou token publicados em `window.__ZAP_SESSION__`;
- tipos operacionais duplicados;
- mocks usados como fallback de produção;
- `VITE_API_BASE_URL` como substituto do roteamento canônico;
- seletor de perfil ou cenário capaz de alterar autorização em produção;
- comandos de agente que aceitem `tenantId`, identidade do ator ou segredo como argumento confiável da LLM.

## Autoridade por camada

| Camada | Pode decidir | Não pode decidir |
| --- | --- | --- |
| UI | renderização, acessibilidade, intenção e confirmação | autorização, ownership, bloqueio da automação |
| Contratos/API client | forma e validação da chamada | regras clínicas e acesso ao banco |
| API/domínio | RBAC, tenant, unidade, versão, idempotência e transação | inferências livres da LLM |
| Policy Gate | permitir ou negar capacidades determinísticas | alterar dados diretamente |
| Hermes | classificar intenção, coletar dados mínimos e redigir proposta | SQL, segredo, preço, equivalência clínica ou agenda confirmada |
| Handoff | solicitar o fluxo canônico | assumir, distribuir ou responder pelo humano |

## Agentes de IA

### Hermes Orchestrator

Mantém contexto somente da conversa/caso atual e produz saída estruturada. Não recebe acesso genérico à API, banco, credenciais ou memória global de pacientes.

### Policy Gate determinístico

Executa antes e depois do modelo. Baixa confiança, erro, conteúdo sensível, pedido humano ou estado de automação incompatível encerram a automação e solicitam handoff.

### Tool Gateway

Expõe ferramentas estreitas e tipadas. Ator e tenant são derivados da sessão interna. Toda mutação tem auditoria, correlation ID, timeout, idempotência e, quando aplicável, `expectedVersion`.

### Scheduling Collector

Coleta preferências, apresenta resumo, pede confirmação e gera handoff. Não reserva nem confirma horário.

### Clinical/Price Guard

Bloqueia cálculo de preço e equivalência clínica. Valores só podem vir de fonte canônica versionada; dúvida clínica gera handoff.

## Invariante de takeover

O composer humano só pode ser habilitado nesta ordem:

```text
validar permissão e expectedVersion
  -> bloquear automação no estado canônico
  -> transferir ownership
  -> confirmar commit/readback ou evento realtime
  -> habilitar resposta humana
```

Ocultar controles no React não é bloqueio operacional. Estados `HUMAN_REQUESTED`, `HUMAN_QUEUED`, `HUMAN_ACTIVE` e `SUSPENDED` devem impedir outbound do Hermes no servidor/worker.

## Migração visual

1. **Shell e estados:** adaptar somente layout, tokens, componentes puros e estados visuais.
2. **Canais:** usar `ConnectionsPanel`, contratos e cliente canônicos; preservar `CORPORATE`, `SINGLE_UNIT` e `SELECTED_UNITS`.
3. **Inbox read-only:** adaptar lista, filtros, detalhe e timeline sobre memberships, grants, paginação e realtime existentes.
4. **Operações humanas:** integrar claim, resolve, requeue, transfer e takeover uma ação por vez, preservando a chave idempotente no retry e reconciliando `409`.
5. **Hermes shadow mode:** avaliar somente mensagens sintéticas, sem outbound, antes de liberar ferramentas não destrutivas.
6. **Remoção do paralelo:** nenhum arquivo equivalente a `api.ts`, `session.ts`, `adapters.ts`, `mocks.ts`, `domain.ts` ou `.env` do protótipo entra no canônico.

## Critérios de aceite

- RBAC continua server-side e a UI deriva ações de grants reais.
- Nenhum request usa `tenantId` fornecido pelo navegador como autoridade.
- Conexão corporativa funciona sem unidade obrigatória.
- Toda mutação usa idempotência e versão quando previstas pelo contrato.
- `401`, `403`, `409`, `503`, resposta inválida, vazio e carga parcial possuem UX verificável.
- Takeover concorrente não permite outbound do Hermes após o estado humano.
- Mocks não ficam no caminho produtivo.
- `pnpm typecheck:all`, `pnpm test:all`, `pnpm api:check` e `pnpm build:all` passam.
- E2E cobre dois tenants, usuário sem permissão, conexão corporativa/multiunidade, claim concorrente, takeover e ausência de outbound automático.

## Evidências canônicas

- `docs/decisions/001-single-canonical-flow.md`
- `docs/decisions/002-hermes-boundary.md`
- `docs/decisions/003-tenant-context-boundary.md`
- `apps/web/src/api.ts`
- `packages/api-client/src/client.ts`
- `apps/api/src/routes/channel-connections.ts`
- `apps/api/src/routes/inbox-handoffs.ts`
- `src/domain/channel-connections.ts`
- `src/domain/handoffs.ts`
- `packages/contracts/src/index.ts`

## Consequências

O protótipo continua sendo referência visual, não um segundo produto. A integração é mais lenta que uma cópia direta, porém preserva segurança, concorrência, multiunidade, testes e manutenção futura.
