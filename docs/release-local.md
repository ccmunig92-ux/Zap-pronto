# Fechamento da release local

Este checklist transforma o estado validado no checkout canônico em uma evidência local reproduzível.
Ele não substitui o cronograma e não autoriza merge ou deploy. O incremento atual está no branch
`codex/phase-4-attendant-availability` e permanece em PR draft; isso não homologa Meta, Hermes, IdP externo ou
produção.

## Escopo

- API, domínio, contratos, cliente gerado, web e banco do mesmo repositório canônico.
- Baseline versionado até `0050_handoff_reopen_latest_episode.sql` e incremento local append-only
  validado até `0056_unit_sla_policy.sql`.
- Overlay OIDC exclusivamente sintético, com duas identidades operacionais locais.
- Outbound externo e Hermes desativados.

## Identidade do candidato

Antes dos gates, registre sem alterar o checkout:

```powershell
Get-Location
git branch --show-current
git rev-parse HEAD
git status --short
git diff --check
```

Todo arquivo novo do corte deve aparecer no inventário deliberado. Arquivo não rastreado omitido torna o
candidato incompleto; árvore suja não deve ser descrita como artefato publicável.

## Integridade das migrations

O migrador grava SHA-256 e recusa uma migration já aplicada cujo conteúdo divergiu. Valores de referência
do fechamento `0050`:

| Migration | SHA-256 |
| --- | --- |
| `0006_outbox_worker.sql` (LF canônico) | `00c385c3b1a1a051d24e763268db530b9585ecefbd4873cda83211510d7cbde8` |
| `0049_handoff_reopen.sql` | `a8b81201c1c10960156c4b990aa36c81aa6a8ad7bb3cb0b7e5c8212ca512ef92` |
| `0050_handoff_reopen_latest_episode.sql` | `db810578003dfe112b571e37e03555c5f0a5d8ca6a6447362302cf8b125a0f65` |

Confira todas as migrations e preserve o resultado junto da evidência da execução:

```powershell
Get-FileHash database/migrations/*.sql -Algorithm SHA256
```

Não reescreva migrations publicadas. Qualquer correção de esquema posterior deve usar o próximo número
append-only e passar tanto pelo banco vazio quanto pelo upgrade legado.

## Evidência local incremental 0055

A migration `0055_sla_acknowledgement_episodes.sql` altera a identidade do reconhecimento de SLA para
`(tenant_id, handoff_id, handoff_version)`. Assim, a listagem associa somente o ACK da versão atual,
um replay continua recuperando o episódio histórico correto e uma nova versão em fila exige novo
reconhecimento. As mutações da Inbox reconciliam também a projeção de alertas para não manter ACK,
versão ou ação stale após claim, requeue, transferência, takeover, resolução ou reabertura.

Evidência executada no checkout local: 92 testes core, 77 da API, 137 do frontend, 5 do overlay e
19/19 jornadas E2E OIDC em runtime, além de banco vazio, upgrade legado, `typecheck:all`,
`api:check`, `build:all` e `git diff --check` verdes. Essas contagens não comprovam CI remoto,
staging, deploy, produção, Hermes ou Meta real.

## Evidência local incremental 0056

A migration `0056_unit_sla_policy.sql` introduz política de SLA versionada por tenant, unidade e
prioridade, sem preencher prazos por convenção ou default. A publicação é append-only, idempotente,
auditada e protegida por versão esperada. A política vigente é capturada somente quando nasce um novo
episódio operacional ou quando um handoff é reaberto: o prazo e a versão aplicada ficam persistidos no
próprio episódio, portanto uma política posterior não recalcula o histórico. Na ausência de política,
o SLA permanece nulo e o alerta `MISSING_SLA` continua explícito.

Evidência executada no checkout local: 95 testes core, 79 da API, 28 do cliente, 149 do frontend, 5
do overlay e 20/20 jornadas E2E OIDC em runtime. Também passaram banco vazio com migrations
`0001`-`0056`, upgrade legado, `typecheck:all`, `test:all`, `api:check`, `build:all`, overlay Verify e
`git diff --check`. O HEAD `0e61817` passou os dois checks remotos `validate`. Essas contagens não
comprovam staging, deploy, produção, Hermes ou Meta real.

## Evidência incremental 0057

A migration `0057_sla_policy_idempotency_serialization.sql` fecha a corrida da chave idempotente entre
unidades, adquirindo o lock do tenant e da chave antes do lock da unidade. O teste concorrente exige um
sucesso, um conflito semântico, um comando, uma versão, quatro targets e uma auditoria. A UI agora
permite a leitura da política pelo supervisor sem renderizar inputs, confirmação ou POST; gestão continua
restrita a gerente e administrador autorizados. O frontend integrado passou 151/151 testes, além de
`typecheck:all`, `api:check`, overlay Verify e `git diff --check`. Banco limpo e upgrade permanecem gates
obrigatórios do CI para este novo HEAD antes de declarar o corte remoto verde.

## Evidência incremental 0058

A migration `0058_team_availability_projection.sql` adiciona a leitura unitária e paginada da
disponibilidade da equipe, autorizada pela capacidade explícita `availability.supervise`. A projeção
calcula atendimentos ativos e capacidade restante no banco, exige tenant, unidade, conta e membership
ativos e não concede leitura direta das tabelas à API. A UI monta o módulo Equipe somente sob demanda,
com filtro de status, deduplicação, descarte de respostas tardias e purge em `401/403`, sem polling ou
mutation. Evidência local até aqui: 98 testes core, 79 da API, 29 do cliente, 158 do frontend, 5 do
overlay, `typecheck:all`, `test:all`, `api:check`, build, diff-check e 21/21 jornadas E2E OIDC em
runtime verdes. Banco limpo/upgrade e CI remoto do 0058 ainda precisam passar.

## Evidência incremental 0059

A migration `0059_unit_operational_timezone.sql` adiciona configuração IANA explícita, versionada e
unitária do fuso operacional, sem criar turnos, recorrência ou enforcement de claim. Supervisores
autorizados recebem leitura; somente gerentes e administradores com `unit_timezone.manage` recebem o
editor. A ausência continua neutra e a UI não presume fuso. O módulo lazy `Escalas` confirma que a
mudança apenas prepara escalas futuras e não altera atendimentos ou responsáveis.

Os gates locais verdes incluem 101 testes core, 81 da API, 31 do cliente, 168 do frontend, 5 do
overlay, `typecheck:all`, `test:all`, `api:check`, build, banco limpo, upgrade e 22/22 jornadas OIDC.
O controlador executa a jornada `America/Sao_Paulo` isoladamente e comprova uma versão, um comando,
uma auditoria `UNIT_OPERATIONAL_TIMEZONE_CONFIGURED` e zero outbound, Hermes ou Meta; o reseed limpa
esse estado antes do bloco residual. Isso não homologa staging, IdP externo, Meta, Hermes ou deploy.

## Evidência incremental 0060

A migration `0060_unit_shift_schedule.sql` adiciona escalas semanais versionadas por unidade e
integrante elegível, com vigência, períodos sem overnight e exceções `CLOSED` ou `REPLACE`. O fuso é
um snapshot da configuração operacional resolvida pelo servidor; navegador e frontend não calculam
nem presumem timezone. A leitura usa `shift.read`, enquanto publicação exige `shift.manage`, versão
esperada e chave idempotente. O corte permanece observacional: não existe scheduler, projeção de turno
atual ou enforcement sobre availability, claim ou transferência.

Os gates integrados verdes abrangem a cadeia limpa de migrations `0001`–`0060`, 108 testes core, 83
da API, 31 do cliente, 176 do frontend e 5/5 do overlay. O harness descobriu 21 jornadas E2E e sua
execução completa terminou verde. A prova isolada da escala confirma exatamente uma versão, um comando
e uma auditoria `SHIFT_SCHEDULE_PUBLISHED`, zero outbound/Hermes/Meta e hash idêntico de availability,
handoffs, conversations e service cases antes e depois da publicação. A leitura de supervisor está
coberta tecnicamente, mas sua jornada real de navegador ainda não foi homologada porque o overlay não
possui identidade OIDC `SUPERVISOR` dedicada. Nenhum deploy, staging ou integração Meta/Hermes foi
executado.

## Evidência incremental 0061

A migration `0061_effective_staff_shift.sql` adiciona uma avaliação efetiva somente leitura da escala
por unidade e integrante. O servidor resolve a versão aplicável, o snapshot de timezone, o dia e
horário locais, a grade semanal e a precedência das exceções, retornando `IN_SHIFT`, `OUTSIDE_SHIFT`,
`CLOSED`, `NOT_EFFECTIVE` ou `UNCONFIGURED`. O avaliador usa `shift.read`, resposta `no-store`,
isolamento por tenant e escopo sanitizado; os testes cobrem bordas de período, exceções e timezone/DST.

A interface apresenta estado, motivo, data, horário e fuso sem calcular a decisão no navegador. O
overlay agora possui `supervisor.local` como identidade OIDC `SUPERVISOR` dedicada e reconciliável em
realm Keycloak persistido. A jornada real provou leitura sem editor, sem `POST /v1` e sem host externo.
Os hashes de availability, handoffs, conversations e service cases antes e depois permaneceram
idênticos.

A cadeia limpa `0001`–`0061` passou com 110 testes core, 84 da API, 31 do cliente, 179 do frontend,
overlay 5/5 e execução E2E completa verde. Este checkpoint não implementa enforcement de claim,
transferência ou takeover, não altera disponibilidade e não executa scheduler, deploy, Meta ou Hermes.

## Gates obrigatórios

Execute no checkout canônico, nesta ordem:

```powershell
pnpm install --frozen-lockfile
pnpm test:all
pnpm typecheck:all
pnpm api:check
pnpm build:all
$env:DATABASE_ADMIN_URL = 'postgresql://postgres:postgres@127.0.0.1:5432/postgres'
pnpm db:test
pnpm db:test:upgrade
node --test deploy/local-oidc/overlay.test.mjs
pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Verify
pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action E2E
git diff --check
```

`api:check` deve terminar sem alterar `packages/api-client/src/generated.ts`. O E2E deve usar somente o
nonce e as contas sintéticas do overlay local. Falha, skip inesperado ou teste não executado impede declarar
o respectivo gate verde.

## Revisão final

- Confirmar isolamento cross-tenant e cross-unit, autorização fail-closed e RLS.
- Confirmar replay idempotente, conflito de fingerprint e um vencedor em concorrência.
- Confirmar que refresh, paginação, abertura e mutações continuam mutuamente exclusivos.
- Confirmar ausência de mensagem outbound, chamada Meta, resposta Hermes ou status falso nos fluxos locais.
- Confirmar que nenhum segredo, token, dump, certificado privado ou `.env` entrou no diff.
- Registrar contagens de testes, resultado do overlay, hashes, branch, `HEAD` e riscos residuais.

## Limite da declaração

Com todos os gates verdes, a declaração permitida é **candidato local validado**. O snapshot deliberado
já existe no branch `codex/release-local-0050`, com PR draft e CI verde. A promoção à `main` exige PR,
check `validate` atualizado, um approval distinto e conversas resolvidas, sem bypass administrativo,
force-push ou deleção da branch. Staging continua bloqueado até
existirem artefato por digest, IdP externo, HTTPS, variáveis e segredos reais, contas sintéticas e
homologação própria. Meta real, merge e deploy permanecem proibidos sem autorização explícita e sem os
gates externos correspondentes.
