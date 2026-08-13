# Cronograma canônico de desenvolvimento

Este cronograma é orientado por gates. Datas não autorizam avançar com critérios de aceite pendentes.

## Status de execução — 07/08/2026

- Fase 0: concluída, publicada e validada no CI remoto.
- Fase 1: concluída, integrada ao `main` e validada no CI remoto (PR #1).
- Fase 2: integrada ao `main` pelo PR #2, com os dois gates do SHA final aprovados.
- Fase atual: **Fase 3 — API, autenticação e RBAC**, reconstruída sobre a `main` sem migrations da Fase 4.
- PostgreSQL real: aprovado localmente em PostgreSQL 18.3.
- Migration do zero: aprovada.
- RLS com dois tenants: SELECT, INSERT, UPDATE e DELETE testados.
- Atribuição de atendente fora da unidade: bloqueada em teste real.
- Controle de migrations por checksum e advisory lock: aprovado localmente.
- CI com PostgreSQL 18, typecheck e testes: aprovado no `main`.
- Primeiro commit canônico local: criado e validado.
- Contexto transacional parametrizado e testes de pool: concluídos.
- Membership ator/tenant validado no banco: implementado localmente.
- Matriz RLS das 19 tabelas: SELECT/INSERT/UPDATE/DELETE cruzados testados localmente.
- Membership ator/tenant e matriz CRUD RLS: concluídos.
- Papéis separados de API e worker: concluídos e reauditos.
- Fase 2A concluída e integrada pelo branch `codex/phase-2-operational-domain`:
  lifecycle tipado, histórico tenant-aware e outbox com lease/dead-letter modelados;
  solicitação de handoff atômica e claim otimista implementados.
- Prova local da Fase 2A: migration do zero, RLS e dois claims concorrentes com exatamente um vencedor.
- Fase 2B concluída localmente: outbox com claim `SKIP LOCKED`, lease/reclaim, ACK por token,
  retry com backoff, dead-letter auditado e privilégios estreitos de API/worker.
- Prova local da Fase 2B: dois workers recebem eventos distintos; lease expirado troca o token;
  ACK obsoleto falha; retry e dead-letter preservam o isolamento por tenant.
- A entrega assíncrona é `at-least-once`; consumidores devem deduplicar por ID/idempotency key.
- Fase 2C concluída localmente: versões de preço DRAFT/PUBLISHED/RETIRED, publicação serializada,
  orçamento com snapshot imutável, cálculo em centavos, revisão humana, envio, aceite,
  recusa, expiração e cancelamento sem qualquer efeito de agendamento.
- Prova local da Fase 2C: versão publicada não é alterável; nova versão preserva o snapshot anterior;
  totais adulterados e snapshots falsos falham; envio concorrente gera uma mutação e replay idempotente;
  aceite vencido falha; eventos e outbox são atômicos às transições.
- Fase 2D concluída localmente: pedido médico com origem inbound validada, páginas OCR e itens
  imutáveis, confiança/política versionadas, revisão humana obrigatória e ilegibilidade fail-closed.
- Prova local da Fase 2D: replay e divergência idempotente, baixa confiança e ilegibilidade em handoff,
  evento clínico compatível com o estado real, isolamento por unidade e rollback integral quando há
  handoff aberto para outro caso; nenhum orçamento ou agendamento é criado.
- Fase 2 concluída localmente: upgrade legado 0001–0004 até 0009 preserva dados e é no-op na
  repetição; registro da migration é atômico ao DDL; RLS comercial e clínica isola filiais.
- Gate final da Fase 2: handoff concorrente com replay único, recebimento/extracão/revisão médica
  concorrentes reconciliados, publicação tardia idempotente e rollback sem efeitos parciais.
- Fase 3A iniciada em branch empilhada própria: workspace full-stack único, contratos TypeBox,
  composition root Fastify, OpenAPI gerado e shell React sem acesso direto ao banco.
- Fase 3A identidade/RBAC em validação: catálogo persistido alinhado a `user_units`, provedores OIDC e
  identidades resolvidas por issuer, audience, organização e subject, com RLS e função estreita.
- Boundary HTTP fail-closed em validação: toda rota `/v1` exige declaração explícita e rotas protegidas
  executam resolução OIDC, contexto RLS e autorização RBAC na mesma transação do caso de uso.
- Primeiro corte vertical da Fase 3 implementado localmente: `GET /v1/me` deriva usuário e tenant do
  OIDC/banco, nega conta sem unidade ativa e expõe vínculos/grants sem dados internos do provedor.
- OpenAPI gera o cliente TypeScript canônico com verificação de drift; o shell React consome somente
  esse cliente e não envia tenant, ator ou unidade como fonte de autorização.
- Fase 3B lifecycle persistente iniciado: migration `0012` separa conta, convite e identidade OIDC,
  normaliza email por tenant, armazena somente digest do token e aplica TTL, estados e RLS; a tabela
  de comandos modela a idempotência, ainda não exposta por rota.
- Prova local da fundação 3B: migration limpa e upgrade legado passam; email case-insensitive duplicado,
  digest inválido, segundo convite pendente e timestamps incoerentes são rejeitados pelo PostgreSQL;
  bloqueio/reativação/revogação são versionados, auditados e serializados por tenant, e revogação OIDC
  ocorre atomicamente. Escrita direta em usuários, vínculos e tabelas de convite foi retirada da API.
- Primeiro corte vertical administrativo 3B concluído localmente: `GET /v1/users/invitations/options` e
  `POST /v1/users/invitations` percorrem React, cliente OpenAPI, API protegida, domínio e PostgreSQL sem
  DTO, mock ou acesso ao banco paralelos. Provider e unidades são opções ativas resolvidas pelo servidor.
- Convites usam token CSPRNG de 32 bytes; somente o SHA-256 é persistido. O token bruto aparece apenas
  no primeiro `201`, nunca em replay, auditoria, outbox ou comando. Se a primeira resposta se perder, a
  operação segura exigirá revogação e reemissão; essa rota ainda é pendente.
- Prova local do convite: RBAC negativo, unidade cross-tenant, JSON/NULL inválido, replay sem duplicação,
  conflito de idempotência, expiração auditada e privilégios SQL estreitos passaram em PostgreSQL real;
  API, cliente, OpenAPI e dez testes web também passaram.
- Lifecycle administrativo 3B concluído localmente no fluxo único: listagens paginadas de usuários e
  convites, bloqueio, reativação e revogação de conta, além de revogação e reemissão atômicas de convite.
  Todas as mutações exigem Idempotency-Key, versão otimista quando aplicável, motivo, auditoria e outbox.
- Reemissão invalida o convite anterior e entrega novo token bruto somente no primeiro `201`; replay não
  recupera token. Self-removal, último administrador, unidade/tenant alheios e concorrência são bloqueados.
- A listagem de convites permanece atrás de função SQL estreita e autorizada; a API não recebeu SELECT
  direto nas tabelas protegidas. Paginação usa cursor validado e limite máximo de 100.
- Prova local do lifecycle administrativo: migrations 0001–0014 e upgrade legado aprovados no PostgreSQL
  real; core com 22 testes, API 14, cliente 7 e frontend 14 aprovados; OpenAPI sem drift.
- Aceite OIDC 3B concluído localmente: rota pré-provisionamento exige Bearer assinado e email verificado;
  o body contém somente o token. Tenant, provedor, usuário, unidades e permissões são derivados no banco.
  A migration `0015` cria conta, vínculos, identidade, aceite, comando, auditoria e outbox atomicamente.
- Token bruto permanece apenas no estado transitório do frontend e nunca entra em URL, storage, log ou SQL;
  concorrência produz um vencedor e replay só é permitido para o mesmo comando e principal verificado.
- Prova local do aceite: migrations 0001–0015 e upgrade aprovados; core 25, API 15, cliente 8 e frontend
  17 testes aprovados. Issuer/audience/org/email divergentes, convite vencido e cross-tenant falham fechados.
- Rate limit distribuído do aceite concluído na migration `0016`: PostgreSQL consome e confirma uma
  tentativa antes da transação de aceite, com chave SHA-256 da identidade verificada, janela fixa de
  15 minutos e máximo de 10 tentativas. A 11ª retorna 429 e `Retry-After`, sem retry automático na UI.
- Prova do limiter: duas conexões concorrentes produziram dez permissões e duas recusas; o consumo
  permanece após rollback posterior, tabela não tem grants diretos e cleanup é limitado com `SKIP LOCKED`.
- Matriz final local de RBAC/IDOR concluída: JWT RS256 assinado, JWKS HTTP, API e PostgreSQL reais
  exercitam dois tenants, duas unidades e os cinco papéis. IDOR cross-tenant retorna 404 genérico,
  versão obsoleta retorna 409 e contas bloqueadas/revogadas perdem acesso na requisição seguinte.
- O frontend desmonta imediatamente estado administrativo e token transitório após 401; após 403,
  consulta `/v1/me` novamente e deixa os grants atuais decidirem a remontagem. O cache de sessão não
  reutiliza grants antigos depois da conclusão da requisição pendente.
- O executor de testes compilados agora enumera `*.test.js` deterministicamente. Isso corrige a falha
  Linux/Node 24 em que `node --test dist` não encontrava a API e reportava falso positivo no cliente.
- As duas execuções do GitHub Actions para o commit `1305c31` concluíram verdes, incluindo tipagem,
  testes, build, integração PostgreSQL e upgrade legado.
- A UI administrativa foi liberada apenas para este corte comprovado; outras telas continuam bloqueadas
  até identidade, matriz RBAC e testes IDOR correspondentes estarem aprovados.
- Fase 3 permanece aberta; fases 4–9 não foram iniciadas.
- Gate que bloqueia o primeiro endpoint da Fase 4: executar em navegador a jornada com um IdP OIDC
  externo homologado, usando ao menos um administrador e um atendente reais, e provar login, `/v1/me`,
  expiração/renovação da sessão e negação após bloqueio. Os testes com JWKS local não substituem esse gate.
- Pré-check operacional desse gate: preencher `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` e, quando
  aplicável, `OIDC_ORGANIZATION_CLAIM`, e executar `pnpm --filter @zap-pronto/api oidc:probe`. O comando
  falha fechado para configuração insegura, discovery divergente, redirect, timeout, JSON inválido ou JWKS
  sem chave pública de assinatura. Ele não recebe tokens e não substitui as duas jornadas reais no navegador.
- O workflow de homologação não executa código de PR com credenciais reais: somente `workflow_dispatch`
  na branch padrão pode usar o environment protegido. O probe aceita apenas chaves públicas RSA compatíveis
  com RS256/verify, exatamente como o verificador de runtime. O E2E exige frontend HTTPS, defaults seguros
  para variáveis opcionais, renovação posterior à expiração original e bloqueio reversível da conta de teste.
- O environment `oidc-homologation` foi criado pela sessão administrativa do proprietário, ainda sem
  variáveis, secrets ou proteções aprovadas. A implantação HTTPS e as duas contas sintéticas exclusivas
  também não estão disponíveis; a Fase 4 continua fechada até configurar e executar o gate na `main`.
- A fundação integrada de staging foi incorporada à `main` pela PR #5 no merge `20fed6d`; o gate sobe PostgreSQL 18.3, aplica migrations,
  neutraliza deriva de privilégios do login runtime, inicia API e web, valida health pelo proxy e prova
  recuperação/persistência após reinício do banco. O CI da `main` no run `31178259803` passou no merge final.
- A fundação operacional de staging foi integrada pela PR #7 no merge `1d6b929`: preflight de
  imagens/secrets/recursos/topologia, publicação GHCR desabilitada até proteção administrativa e depois
  condicionada a scan/SBOM/provenance, backup/restore adversarial, verificação pós-deploy e rollback com
  digest e attestation. O CI final da `main` passou no run `31181220736`.
- Hardening local adicional do bootstrap OIDC concluído: falhas de configuração, storage e callback
  deixam a aplicação fechada; query e fragmento do callback são removidos antes do processamento;
  falha dupla na limpeza produz estado `blocked` sem montar React; retry é single-flight e não libera
  a API antes de `ready`. O build recusa callback/logout fora da mesma origin HTTPS ou com query/hash.
- Checkpoint local integrado concluído no Windows: 33 testes web, 3 testes do validador OIDC,
  `test:all`, `typecheck:all`, `api:check`, builds Docker de API/web, smoke completo
  PostgreSQL→migrations→provisionamento→API→web com reinício/persistência, `db:test` e
  `db:test:upgrade` passaram. O Dockerfile web normaliza o entrypoint para LF e `.gitattributes`
  fixa scripts POSIX em LF para impedir regressão CRLF entre Windows e Linux.
- Esse checkpoint permanece exclusivamente local e não substitui o gate externo: nenhum login,
  renovação, revogação ou RBAC foi homologado contra IdP HTTPS real nesta etapa.

## Premissas

- Um único monólito modular no MVP; sem microserviços prematuros.
- PostgreSQL próprio é a fonte de verdade.
- Escopo de tenant e unidade nunca é aceito diretamente do corpo da requisição.
- Hermes não acessa SQL, não confirma agenda e para imediatamente no takeover humano.
- Integrações Meta e sistemas externos entram pelo mesmo envelope canônico.
- ProntoMedic é o primeiro tenant e uma integração opcional, não o núcleo da plataforma.

## Visão geral

| Fase | Prazo alvo | Resultado obrigatório | Gate de saída |
|---|---:|---|---|
| 0. Baseline | 2 dias | PostgreSQL real, CI e baseline Git | Migration executa do zero e testes passam |
| 1. Dados e segurança | 5 dias | RLS, integridade, estados, idempotência e LGPD mínima | Dois tenants isolados em testes reais |
| 2. Persistência e domínio | 5 dias | Repositórios transacionais, orçamento, pedido médico e outbox | Concorrência e transições inválidas bloqueadas |
| 3. API, autenticação e RBAC | 5 dias | API modular, login, convites e permissões por unidade | Matriz RBAC e testes IDOR aprovados |
| 4. Inbox e operação humana | 7 dias | Filas, claim, takeover, SLA e transferência | Um único responsável e zero resposta Hermes após takeover |
| 5. Gateway e mídia | 5 dias | Envelope, webhooks, worker e storage privado | Replay não duplica e mídia permanece privada |
| 6. Hermes, áudio e documentos | 7 dias | Coleta assistida, transcrição e extração revisável | Baixa confiança sempre gera handoff |
| 7. Canais Meta | 10 dias | WhatsApp e depois Instagram/Messenger | E2E real por canal em sandbox oficial |
| 8. Integrações externas | 7 dias/conector | Hub de capacidades e primeiro adaptador | Plataforma funciona mesmo sem o sistema externo |
| 9. Hardening e staging | 5 dias | Observabilidade, backup, carga, segurança e rollback | Restore e rollback comprovados |

Estimativa do MVP com WhatsApp: 8 semanas. Três canais Meta, App Review e homologação completa: 10 a 12 semanas. A estimativa pressupõe uma equipe pequena dedicada e acesso tempestivo às contas de sandbox.

## Fase 0 — baseline executável

Entregas:

- subir PostgreSQL local descartável;
- executar migration do zero;
- adicionar controle de migrations;
- criar CI com typecheck, testes e banco real;
- criar configuração local sem segredos;
- revisar e criar o primeiro commit canônico.

Critérios de aceite:

- banco vazio sobe de forma reproduzível;
- migration executa sem correção manual;
- nenhum segredo está versionado;
- testes atuais e testes SQL passam no CI.

## Fase 1 — isolamento e integridade

Entregas:

- RLS com `ENABLE` e `FORCE ROW LEVEL SECURITY`;
- tenant transacional via `SET LOCAL app.tenant_id`;
- papel da aplicação sem `BYPASSRLS`;
- coerência entre handoff, caso, conversa e unidade;
- atribuição restrita a atendentes autorizados na unidade;
- regras de escopo do canal e unidade;
- estados tipados e transições válidas;
- identidade externa por canal;
- idempotência inbound e outbound;
- política mínima de retenção, consentimento e auditoria append-only.

Critérios de aceite:

- tenant A não lê, insere, altera ou exclui dados do tenant B;
- handoff incompatível com caso/conversa/unidade falha;
- atendente de outra unidade não assume conversa;
- webhook concorrente e repetido produz um único efeito;
- canal só roteia para unidade autorizada.

## Fase 2 — domínio operacional e persistência

Entregas:

- repositórios transacionais;
- lifecycle de conversa, caso e handoff;
- suspensão do Hermes e criação do handoff na mesma transação;
- orçamento, itens, versão da tabela, validade, revisão, envio e aceite;
- pedido médico, páginas, itens extraídos, confiança e revisão humana;
- metadados de áudio e OCR;
- outbox com lease, backoff, tentativas e dead-letter;
- controle de concorrência otimista.

Critérios de aceite:

- somente um atendente vence o claim concorrente;
- orçamento é reproduzível centavo a centavo;
- baixa confiança ou documento ilegível cria handoff;
- falha assíncrona entra em retry e depois dead-letter;
- transições inválidas são rejeitadas no domínio e no banco.

## Fase 3 — API, autenticação e RBAC

Entregas:

- API modular única com OpenAPI e validação de entrada;
- autenticação OIDC substituível;
- convites, ativação, bloqueio e revogação;
- permissões granulares por tenant e unidade;
- rate limit, correlation ID e auditoria;
- proteção contra IDOR.

Papéis iniciais: administrador do tenant, gerente de unidade, supervisor, atendente e auditor.

Critérios de aceite:

- matriz de permissões automatizada por rota;
- usuário bloqueado perde acesso;
- administrador de unidade não acessa outra filial;
- toda mutação relevante registra ator, escopo e correlation ID.

## Fase 4 — inbox multiusuário e produtividade

Entregas:

- filas por unidade, equipe e competência;
- roteamento corporativo com confirmação de unidade;
- claim atômico, transferência, devolução, reabertura e encerramento;
- inbox em tempo real e composer humano;
- SLA de espera e primeira resposta;
- turnos, presença, pausas e capacidade;
- alertas configuráveis de baixa produtividade.

O alerta só pode disparar quando há atendente em turno, demanda disponível, limiar violado por uma janela sustentada e cooldown encerrado. O sistema registra alerta, destinatário, reconhecimento, justificativa e escalonamento.

Critérios de aceite:

- uma conversa possui no máximo um responsável ativo;
- takeover suspende o Hermes antes da resposta humana;
- transferência preserva histórico e motivo;
- alerta não dispara sem demanda, fora do turno ou em pausa autorizada;
- reconexão da UI não perde eventos.

### Primeiro corte vertical da Fase 4 — inbox humana mínima

Este corte permanece **bloqueado pelo gate final da Fase 3** e não deve registrar rotas antes da prova
OIDC externa descrita acima. Quando liberado, deve reutilizar exclusivamente `human_handoffs`,
`conversations`, `service_cases`, `workflow_transitions`, outbox, RLS, `protectedRoute` e o cliente
OpenAPI existentes.

Escopo mínimo, sem frontend neste primeiro commit:

1. `GET /v1/inbox/handoffs?unitId=<uuid>&limit=<1..100>&cursor=<opaco>` com permissão
   `handoff.read` e escopo unitário validado no banco. Retorna somente handoffs `QUEUED` de unidade ativa
   à qual o ator pertence, ordenados deterministicamente por prioridade, `queued_at` e `id`.
2. `POST /v1/inbox/handoffs/{handoffId}/claim`, `Idempotency-Key` obrigatório e body contendo apenas
   `expectedVersion`. A unidade é resolvida pelo handoff sob RLS; tenant, unidade e ator nunca vêm do body.
3. A rota de claim chama o `claimHandoff` canônico na mesma transação de autenticação, RBAC e RLS.
   Um único concorrente muda handoff `QUEUED -> ACTIVE`, caso `WAITING_HUMAN -> IN_REVIEW` e conversa
   `HUMAN_QUEUED -> HUMAN_ACTIVE`; o perdedor recebe 409 genérico.
4. O response inclui identificadores, status, versão e estado de automação, mas não payload clínico,
   token de canal ou metadados internos. Erros cross-tenant/cross-unit convergem para 404 genérico.

Migration incremental exigida antes da rota:

- comando idempotente de claim por `(tenant_id,idempotency_key)` e fingerprint
  `(handoffId,expectedVersion,actorId)`, com replay do mesmo vencedor e conflito para payload/ator diferente;
- função SQL estreita de listagem unit-scoped e função de claim, ou grants mínimos equivalentes, sem conceder
  UPDATE direto das tabelas operacionais ao handler HTTP;
- índice da fila compatível com `(tenant_id,unit_id,status,priority,queued_at,id)` e prova por `EXPLAIN`;
- auditoria e outbox atômicas contendo correlation ID, sem PII desnecessária.

Gate automatizado do corte:

- PostgreSQL real com dois tenants, duas unidades e dois atendentes concorrentes: exatamente um claim;
- atendente de outra unidade e papéis sem `handoff.claim` recebem negação sem revelar existência;
- replay da mesma chave não incrementa versões nem duplica audit/outbox; fingerprint divergente retorna 409;
- antes e depois do claim, `automation_status` permanece em estado que veta Hermes
  (`HUMAN_QUEUED`/`HUMAN_ACTIVE`); teste adversarial deve provar que o futuro comando outbound do Hermes
  falha fechado nesses estados;
- matriz route-policy/OpenAPI inclui permission+unit scope e respostas 400/401/403/404/409;
- nenhuma rota de transferência, composer, presença, produtividade ou realtime entra neste corte.

## Fases 5 a 9

Checkpoint local inbound: webhook Meta assinado, recibo idempotente, roteamento explícito,
materialização transacional e runner canônico foram implementados sem Hermes ou download de mídia.
O runner usa claim SQL allowlisted apenas para `channel.inbound.received`, credencial PostgreSQL
exclusiva, lease/retry/dead-letter existentes e ACK atômico dentro do materializador.
`channel.inbound.routing_required` nunca é materializado pelo worker e é encerrado somente pelo fluxo
administrativo explícito descrito abaixo. A existência deste corte local não substitui homologação OIDC/Meta externa.

Checkpoint local de roteamento administrativo: fila protegida e paginada de receipts `UNROUTED`,
projeção sem PII, seleção explícita entre mappings ativos e comando idempotente/concorrente foram
integrados à Inbox canônica. A resolução encerra o `routing_required`, publica exatamente um
`channel.inbound.received` e deixa o worker existente materializar a mensagem. As permissões
`inbound.routing.read/resolve` são concedidas inicialmente somente a `TENANT_ADMIN`; não há grant
individual de atendente no modelo atual. Nenhum canal Meta externo ou deploy foi ativado.

Checkpoint local de leitura da Inbox: a fila de handoffs existente passou a abrir o detalhe da conversa
e o histórico paginado em funções SQL estreitas. `conversation.read` é unit-scoped e
`conversation.supervise` separa a leitura de uma conversa `HUMAN_ACTIVE` pelo responsável daquela
feita por supervisão. Texto inbound permanece `UNTRUSTED`; mídia é exibida somente como marcador
sem payload, locator ou download. O corte é estritamente read-only: não envia mensagem, não publica
outbox, não chama Hermes e ainda não representa homologação funcional externa.
O mesmo painel agora inclui `Meus atendimentos ativos`, derivado exclusivamente de handoffs `ACTIVE`
e conversas `HUMAN_ACTIVE` atribuídos ao ator autenticado, com paginação keyset por `claimed_at,id`.
O claim humano também foi conectado ao comando canônico da Inbox: a projeção server-side fornece
`handoffId+expectedVersion`, a UI reutiliza uma chave idempotente por intenção, refaz fila, ativos e
detalhe após o commit e não mantém estado otimista. O E2E local prova um único POST, persistência após
reload, exatamente um `handoff.claimed` e ausência de mensagem outbound ou Hermes durante o claim;
o composer só aparece depois que a conversa passa a `HUMAN_ACTIVE` para o responsável.

Checkpoint local de resposta humana TEXT: o responsável por uma conversa `HUMAN_ACTIVE` pode usar
`message.send` para registrar texto simples no comando transacional canônico. A intenção valida a versão
da conversa, ownership, handoff/caso, unidade e conexão, reutiliza a mesma chave idempotente em retry e
grava exatamente uma mensagem `OUTBOUND/HUMAN` com estado `QUEUED` e um
`channel.outbound.requested` sem conteúdo ou identificadores externos. A Inbox mostra “Pendente de
envio” e não afirma entrega. O E2E local prova claim, um único POST, persistência após reload e ausência
de Hermes ou tráfego externo. Não existe envio Meta, reconciliação de status nem rate limit distribuído
adequado para este comando; body limitado e idempotência reduzem abuso, mas proteção edge/DB continua
pendente antes de exposição real.

Checkpoint local de cancelamento outbound: enquanto a intenção TEXT permanece `PENDING`, com zero
tentativas, sem lease, publicação ou identificador externo, o mesmo responsável pode executar
`QUEUED -> CANCELLED`. A mensagem não é apagada e a timeline mostra “Envio cancelado”. O comando
idempotente incrementa a versão da conversa, cancela o outbox e audita apenas IDs internos; qualquer
evidência de claim/tentativa falha com conflito e não simula cancelamento no provedor. Este corte não
adiciona runner outbound, adapter Meta, status `SENT` nem chamada externa.

Checkpoint local de reconciliação Meta: callbacks de status que atravessam o webhook assinado são
persistidos como recibos append-only e aplicados monotonicamente a mensagens outbound correlacionadas
por conta/conexão e identificador externo. O harness local usa uma mensagem sintética explicitamente
seedada como `SENT`; portanto prova somente `DELIVERED`/`READ`, replay e regressão locais, não envio,
aceite do provedor nem homologação Meta. Intenções `QUEUED` sem identificador externo permanecem
`UNMATCHED` até existir um envio real.

Hardening incremental: eventos Meta com `occurred_at` além de dez minutos no futuro continuam como
evidência append-only, mas recebem `IGNORED_INVALID_TIMESTAMP` e não alteram mensagem nem timestamps.
O mesmo resultado fail-closed é aplicado quando um callback correlacionado antecede a criação da
mensagem em mais de dez minutos; a aplicação referencia a mensagem para auditoria interna, preserva o
estado anterior e permite que um callback cronologicamente válido posterior seja reconciliado.
A Inbox apresenta os estados outbound locais `QUEUED`, `SENT`, `DELIVERED`, `READ`, `FAILED` e
`CANCELLED`; isso é apresentação de evidência recebida, não comprovação de envio ou homologação Meta.

Checkpoint local de encerramento humano: somente o atendente dono de um handoff `ACTIVE` pode usar a
ação server-side `RESOLVE_HANDOFF`. O comando idempotente encerra handoff, caso e conversa na mesma
transação, suspende a automação e publica apenas `handoff.resolved`; não envia mensagem, não reativa o
Hermes e não cria integração externa.

- Gateway: webhook rápido, envelope canônico, worker, ordem por conversa, storage privado, antivírus e estados de entrega.
- Hermes: ferramentas estreitas para consulta, coleta e handoff; guardrails clínicos; prompts versionados e avaliações adversariais.
- Meta: WhatsApp Cloud API primeiro; Instagram e Messenger reutilizam o envelope. Assinatura, janela, templates, mídia, status, token e App Review são obrigatórios.
- Integrações: capacidades `DISABLED`, `READ_ONLY` e `HUMAN_CONFIRMED_WRITE`, sempre com timeout, circuit breaker, idempotência e reconciliação.
- Hardening: métricas, logs, traces, SLOs, backup/restore, carga, segurança, LGPD, runbooks, staging isolado e rollback.

Referências públicas estudadas para os padrões da Fase 5: OpenBSP (envelope e adaptadores),
Hiberius/whatsapp-receptionist (handoff, outbox e áudio), Chatwoot (UX), exemplos oficiais da Meta
(comportamento de eventos) e `@kapso/whatsapp-cloud-api` (tipos e assinatura). O corte canônico apenas
aplica os padrões compatíveis à arquitetura existente; nenhum código, SDK, serviço ou estrutura desses
projetos foi copiado ou incorporado.

## Sequência imediata

Checkpoint local concluído em 2026-08-09: o overlay canônico subiu Postgres, migração,
provisionamento, seed sintético, Keycloak, API, web e edge TLS somente em loopback. Discovery/JWKS,
PKCE, login administrador e atendente, RBAC, renovação após expiração, logout e
bloqueio/reativação e claim humano na Inbox passaram na suíte Playwright existente (5/5). Essa evidência é local e não
substitui o gate OIDC externo anterior à Fase 4.

Checkpoint local incremental em 2026-08-10: a Inbox passou a serializar claim, envio, cancelamento e
encerramento por um único lock síncrono com proprietário exclusivo, e as listas de fila e atendimentos
ativos receberam paginação independente com single-flight, deduplicação e descarte de respostas de
unidade/contexto antigos. A migration append-only `0028` adicionou fingerprint SHA-256 canônico à
solicitação de handoff, preservando replay legado por comparação dos quatro campos e serializando
tenant+chave antes do caso. Passaram 17 testes direcionados da Inbox, 58 testes core, 52 da API,
16 do cliente e 53 do frontend, além de typecheck, OpenAPI sem drift, build, banco limpo, upgrade
legado, overlay e 9 jornadas Playwright OIDC locais. Nenhuma conta Meta foi conectada e essa prova
sintética local não constitui homologação Meta nem OIDC externa.

Checkpoint local incremental em 2026-08-10, migration `0029`: o mesmo processo de worker recebeu a
fundação outbound especializada sobre o outbox canônico, com claim `SKIP LOCKED`, lease fencing,
retry/dead-letter e finalização atômica `SENT`+`PUBLISHED` permitida somente após um identificador
externo válido retornado por transporte explicitamente injetado. O runtime permanece com
`OUTBOUND_WORKER_ENABLED=false`; não há transporte HTTP, credencial Meta ou fallback mock/no-op, e
habilitar a flag sem implementação de transporte falha no startup. Envio e cancelamento também passam
a serializar tenant+operação+chave antes dos locks de conversa; testes concorrentes em conversas
distintas retornam conflito de domínio sem `23505`. Passaram 57 testes da API, 58 core, 16 do cliente,
53 do frontend, banco limpo, upgrade legado, typecheck, OpenAPI sem drift, build, overlay e 9 jornadas
Playwright OIDC locais. As mensagens continuam `QUEUED` localmente por desenho e nenhuma chamada ou
homologação Meta externa foi realizada.

Checkpoint local incremental em 2026-08-11: a Inbox manteve atualização exclusivamente explícita,
sem polling, endpoint ou serviço novo. O refresh lê fila e atendimentos ativos e, quando há seleção,
detalhe e primeira página de mensagens; o snapshot só é publicado depois de todas as leituras
válidas. Locks síncronos impedem cruzamento no mesmo tick entre refresh, mutações e paginação;
respostas antigas são descartadas por unidade e geração. `401`/`403` purgam o contexto sensível,
`404` do detalhe reconcilia as listas e limpa a seleção, e uma conversa autorizada aberta por
paginação permanece selecionada mesmo fora da primeira página. Draft e intenção idempotente coerente
são preservados na mesma unidade/conversa. Passaram 19 testes direcionados da Inbox, 58 testes core,
57 da API, 16 do cliente e 55 do frontend, além de typecheck, OpenAPI sem drift, build, banco limpo,
upgrade legado, overlay/Verify e 9 jornadas Playwright OIDC locais. Nenhuma chamada Meta, commit,
push, deploy ou homologação externa foi realizada.

Checkpoint local incremental em 2026-08-11, abertura da Inbox: detalhe e primeira página de
mensagens passam a ser publicados atomicamente sob um lock operacional síncrono compartilhado com
refresh e paginações e consultado pelas mutações. `404` em qualquer leitura da conversa purga
seleção, detalhe, mensagens, draft e intenções idempotentes, reconcilia fila e atendimentos ativos e
exibe somente aviso neutro. `401`/`403` invalidam a geração e purgam o contexto antes dos callbacks;
falha `5xx` remove loading e dados da conversa e mantém apenas erro sanitizado. Unidade e geração
impedem respostas tardias de publicar estado. Passaram 26 testes direcionados da Inbox, 58 testes
core, 57 da API, 16 do cliente e 62 do frontend, além de typecheck, OpenAPI sem drift, build, banco
limpo, upgrade legado, overlay/Verify e 9 jornadas Playwright OIDC locais. Nenhuma migration, API,
polling, transporte Meta, conta externa, commit, push ou deploy foi alterado ou executado neste corte.

Checkpoint local incremental em 2026-08-11, migration `0030`: o atendente proprietário pode devolver
um handoff `ACTIVE` à fila pelo comando idempotente `handoff.requeue`. A transação retorna handoff,
caso e conversa a `QUEUED`, `WAITING_HUMAN` e `HUMAN_QUEUED`, limpa os dois owners e mantém Hermes
bloqueado. A função estreita exige permissão unitária, ownership, versão esperada, unidade ativa,
agregados coerentes e ausência de outbound humano `QUEUED`; replay e concorrência produzem somente
três transições, um audit e um outbox local. Claims recorrentes passaram a usar snapshot estável,
advisory lock por tenant+chave e evento versionado. Contrato, rota, cliente e Inbox foram integrados,
sem mensagem, transporte ou chamada Meta. Passaram 59 testes core, 58 da API, 17 do cliente e 63 do
frontend, banco limpo, upgrade legado, typecheck, OpenAPI sem drift, build, overlay/Verify e 9 jornadas
Playwright OIDC locais, incluindo claim, devolução, reload e retorno à fila. Transferência direta para
outro atendente permanece no próximo corte porque requer catálogo estreito de candidatos elegíveis e
um segundo contexto OIDC; nenhuma API administrativa foi reutilizada. Não houve commit, push ou deploy.

Checkpoint local incremental em 2026-08-11, migration `0031`: transferência direta altera somente o
owner e a versão do handoff `ACTIVE` e da conversa `HUMAN_ACTIVE`; o caso permanece `IN_REVIEW` sem
versionamento. O catálogo dedicado retorna apenas `id` e `displayName`, exige owner atual e permissão
unitária `handoff.transfer`, e exclui o próprio ator, `AUDITOR`, usuário bloqueado/revogado, vínculo
ausente, outra unidade/tenant e unidade inativa. O comando usa fingerprint SHA-256 completo, advisory
lock tenant+chave, locks dos agregados e `FOR SHARE` sobre usuário/vínculo/unidade de destino;
replay retorna snapshot estável e concorrência não duplica transições, audit ou outbox. A Inbox oferece
seleção e confirmação, lock síncrono e retry com a mesma chave, removendo o atendimento do owner antigo
após sucesso. Passaram 61 testes core, 59 da API, 18 do cliente e 64 do frontend, banco limpo com matriz
concorrente de 10 chamadas, upgrade legado, typecheck, OpenAPI sem drift, build, overlay/Verify e 9
jornadas Playwright OIDC locais. O happy path browser entre dois atendentes não foi executado porque o
overlay possui somente um principal `ATTENDANT`; a integração foi provada em DB/API e não houve
mensagem, Hermes, transporte Meta, commit, push ou deploy.

Checkpoint local incremental em 2026-08-11, migration `0032`: a fila da Inbox deriva SLA no servidor
com um único instante congelado no cursor v2 (`OVERDUE`, `DUE_SOON` em até 15 minutos e `ON_TRACK`),
mantendo ausência de prazo como `null`. A ordenação keyset combina prioridade, presença/data do SLA,
data de entrada e id; o cursor vincula unidade, filtros e relógio e rejeita versões antigas ou âncoras
incompatíveis. A rota existente ganhou filtros fechados de prioridade/SLA e a UI ganhou filtros e badges
textuais, sem endpoint, cron, polling ou escrita operacional adicional. Passaram 62 testes core, 59 da
API, 18 do cliente e 65 do frontend (204), banco limpo, upgrade legado, typecheck, OpenAPI sem drift,
build, overlay/Verify e 9 jornadas Playwright OIDC locais. O E2E detectou e a implementação corrigiu a
projeção SLA ausente na resposta do claim antes do verde final. As migrations `0001`-`0031` tiveram 31
checksums SHA-256 conferidos; `0031` permaneceu `B3D1713A23FE121C614A5E978E9ECA8EFB8E7AE0272BDA3D2656B9F182F02B23`.
Não houve Hermes, transporte Meta real, commit, push ou deploy.

Checkpoint local consolidado em 2026-08-12, migrations `0033`-`0037`: a supervisão passou a listar
atendimentos ativos da unidade por projeção estreita, paginação keyset e permissão explícita, e o
takeover idempotente transfere o ownership ao supervisor sem alterar os estados `ACTIVE`,
`HUMAN_ACTIVE` e `IN_REVIEW`. O lifecycle de memberships ganhou revogação e reativação versionadas,
auditadas e fail-closed; catálogos operacionais retornam somente os campos necessários e respeitam
tenant, unidade, usuário ativo, vínculo ativo e papel elegível. A RLS dos pedidos médicos foi alinhada
ao vínculo ativo, e a migration `0037` corrigiu a projeção tipada da lista supervisionada no PostgreSQL
real. Esses cortes permaneceram no backend, cliente e mesma Inbox canônicos, sem novo serviço ou
transporte externo.

Checkpoint local consolidado em 2026-08-12, migrations `0038`-`0039`: a transferência revalida
membership `ACTIVE` dentro da transação e exige coerência entre unidade, conversa aberta, caso e
handoff antes de alterar ownership. `ASSIGNEE_NOT_ELIGIBLE` passou a produzir conflito operacional
sanitizado, sem erro interno. O replay da transferência também revalida contexto autenticado,
permissão `handoff.transfer` e vínculo ativo, sem permitir que usuário bloqueado ou revogado recupere
snapshot por uma chave antiga. A jornada OIDC local comprovou takeover supervisionado com exatamente
um comando por intenção e sem mensagem, Hermes ou outbound.

Checkpoint local consolidado em 2026-08-12, migration `0040`: transferência direta passou a exigir
motivo operacional fechado (`SHIFT_CHANGE`, `LOAD_BALANCING`, `SPECIALIZED_SUPPORT` ou
`OPERATIONAL_CONTINUITY`). O motivo integra fingerprint e idempotência, aparece em workflow, audit e
outbox, e texto livre é rejeitado. Replay idêntico preserva o snapshot; mesma chave com motivo
divergente retorna conflito. A mesma Inbox exige candidato, motivo e confirmação, preserva a chave no
retry e invalida a intenção quando candidato, motivo ou versão mudam.

Checkpoint local consolidado em 2026-08-12, migration `0041`: atribuição humana e lifecycle de
membership passaram a usar serialização compatível. Se a revogação vencer, claim, transfer ou
takeover são rejeitados; se a atribuição vencer, a revogação falha enquanto existir trabalho ativo.
Assim, o estado final não pode manter atendimento `ACTIVE/HUMAN_ACTIVE` atribuído a membership
`REVOKED`. Replays legados sem motivo não podem atravessar o contrato moderno. A Inbox também
reconcilia atomicamente fila, ativos próprios e supervisionados após transferência/devolução e purga
seleção, draft e intenções em conflitos ou recursos desaparecidos.

Checkpoint local consolidado em 2026-08-12, migration `0042`: encerramento humano passou a exigir
confirmação e disposição fechada (`RESOLVED`, `DUPLICATE`, `CUSTOMER_WITHDREW` ou
`EXTERNAL_REFERRAL`). A disposição integra fingerprint, comando, workflow, audit e outbox; texto livre
e replay legado sem disposição são rejeitados pelo contrato moderno. Cancelar a confirmação não gera
mutação, retry idêntico conserva a chave, e divergência de disposição produz conflito. O encerramento
continua suspendendo a automação e não envia mensagem nem aciona Hermes ou Meta.

Checkpoint local consolidado em 2026-08-12, migration `0043`: os comandos de encerramento e
devolução persistem a unidade operacional e revalidam `handoff.resolve` ou `handoff.requeue` antes
de qualquer replay. Revogação de membership ou perda do grant torna a chave antiga invisível, sem
novo command, workflow, audit ou outbox. Na Inbox, a confirmação do POST agora é separada da
reconciliação de leitura: uma falha parcial após commit remove imediatamente intenção e ações stale,
exibe aviso neutro e não oferece retry que duplicaria uma operação já concluída.

Prova verde consolidada até a migration `0043`: 273/273 testes automatizados e 15/15 jornadas E2E
OIDC locais. Passaram banco limpo, upgrade legado, `typecheck:all`, verificação OpenAPI/cliente,
`build:all`, overlay Verify e `git diff --check`. Essa evidência é exclusivamente local; não houve
integração ou homologação Meta real, commit, push ou deploy.

Checkpoint local consolidado em 2026-08-12, migrations `0044`-`0045`: gestores e supervisores com
`handoff.history.read` podem descobrir atendimentos encerrados da própria unidade em uma projeção
estreita, paginada e read-only. A timeline histórica usa cutoff SQL no instante do encerramento antes
do `ORDER BY/LIMIT`, e detalhe, mensagens, draft e ações são defensivamente desativados na UI. A
`0045` corrige de forma append-only o join do resolvedor depois que o checksum da `0044` já havia sido
registrado pelo overlay. Prova verde: 281/281 testes automatizados, 16/16 jornadas E2E OIDC locais,
banco limpo, upgrade legado, `typecheck:all`, OpenAPI/cliente, `build:all`, overlay Verify e
`git diff --check`. A consulta histórica não alterou handoff, conversa, mensagens, audit ou outbox e
não acionou Hermes, host externo ou Meta.

Checkpoint local consolidado em 2026-08-12, migration `0046`: detalhe e timeline de conversas
`CLOSED` agora exigem `handoff.history.read` na própria unidade, fechando a descoberta por UUID por
atendentes ou auditores sem acesso ao histórico. Conversas `OPEN` preservam o fluxo operacional
anterior. A prova adversarial no PostgreSQL cobre gestor e supervisor autorizados, atendente, auditor
e membership revogada negados, isolamento tenant/unidade, ordenação e paginação keyset, disposição
legada, resolvedor, cutoff anterior ao `LIMIT` e ausência de efeitos em audit, workflow, mensagens e
outbox. O fingerprint de encerramento também normaliza UUID para lowercase. Prova verde: 282/282
testes automatizados, 16/16 jornadas E2E OIDC locais, banco limpo, upgrade legado,
`typecheck:all`, OpenAPI/cliente, `build:all`, overlay Verify e `git diff --check`.

Checkpoint local consolidado em 2026-08-12, migration `0047`: o histórico encerrado aceita filtros
opcionais e combináveis por prioridade, disposição e intervalo temporal semiaberto (`>= início` e
`< fim`) no endpoint canônico. O cursor v2 vincula unidade e todos os filtros, rejeitando cursor
legado, adulterado ou reutilizado em outra consulta. A função SQL revalida a âncora sob os mesmos
predicados, limita a janela a 366 dias, preserva RBAC/tenant e permanece read-only; um índice dedicado
evita varredura dos commands de encerramento. Na Inbox, filtros têm labels PT-BR, aplicação explícita,
single-flight, generation guard e preservação em refresh, paginação e reconciliação. Prova verde:
290/290 testes automatizados, 16/16 jornadas E2E OIDC no overlay reconstruído, banco limpo,
upgrade legado, `typecheck:all`, OpenAPI/cliente, `build:all`, overlay Verify e `git diff --check`.

Checkpoint local consolidado em 2026-08-12, migration `0048`: o cutoff da timeline encerrada deixou
de depender do cliente. Para conversas `CLOSED`, o PostgreSQL limita toda consulta ao menor valor
entre `before` e `closed_at`, usa o mesmo limite na validação do cursor e rejeita agregados encerrados
sem timestamp terminal. A função histórica legada perdeu `EXECUTE` da API; a v2 filtrada permanece
canônica. A Inbox valida 366 dias antes da rede, preserva o snapshot em erro, sinaliza filtros não
aplicados, oferece limpeza explícita, mostra disposição/motivo e expõe seleção/detalhe acessíveis.
Prova verde: 292/292 testes automatizados, 16/16 jornadas E2E OIDC no overlay reconstruído, banco
limpo, upgrade legado, `typecheck:all`, OpenAPI/cliente, `build:all`, overlay Verify e
`git diff --check`.

Checkpoint local consolidado em 2026-08-12, shell modular: a aplicação monta somente o módulo
selecionado entre Inbox, Roteamento, Acessos, Vínculos e Visão geral, sempre derivado dos grants
atuais e sem persistir seleção em URL ou storage. Módulos inativos não executam leituras nem mantêm
PII no DOM; perda de grant aplica fallback fail-closed. Navegação é bloqueada durante mutações,
diálogos e token de convite, e exige confirmação antes de descartar draft ou intenção idempotente.
Logout desmonta os dados sensíveis no mesmo tick e conclui o IdP em best effort. Prova verde:
288/288 testes automatizados, 16/16 jornadas E2E OIDC no overlay reconstruído, banco limpo,
upgrade legado, `typecheck:all`, OpenAPI/cliente, `build:all`, overlay Verify e `git diff --check`.

Checkpoint local consolidado em 2026-08-12, migration `0049`: gestores e supervisores podem
reabrir um atendimento encerrado sem alterar o episódio histórico. O comando idempotente preserva
o handoff fonte `RESOLVED`, cria um novo episódio `QUEUED`, reabre caso e conversa em fila humana e
mantém Hermes bloqueado. Autorização unitária e histórica é revalidada inclusive no replay; locks,
fingerprint, versão esperada e concorrência garantem um vencedor. A ação não é oferecida quando há
outbound humano pendente e nenhum caminho cria mensagem, envio, Hermes ou chamada Meta. Prova verde:
299/299 testes automatizados, 17/17 jornadas E2E OIDC no overlay reconstruído, banco limpo, upgrade
legado, `typecheck:all`, OpenAPI/cliente gerado, `build:all`, overlay Verify e `git diff --check`.

Checkpoint local consolidado em 2026-08-12, migration `0050`: a reabertura só aceita o episódio
`RESOLVED` mais recente da conversa. Episódios ancestrais continuam consultáveis no histórico, mas
não recebem `reopenTarget` e não podem restaurar prioridade, motivo ou SLA obsoletos. O resolvedor
de escopo reconhece a mesma chave do mesmo ator antes de comparar o payload, permitindo que replay
divergente chegue ao comando e retorne `409` sem revelar escopo. A matriz adversarial cobre
401/403/404/409/5xx, purge, reconciliação, retry com a mesma chave, exclusão mútua, unmount e falha
pós-commit; o navegador confirma reload e replay divergente. Prova verde: 306/306 testes
automatizados, 17/17 jornadas E2E OIDC, banco limpo, upgrade legado, `typecheck:all`, OpenAPI/cliente,
`build:all`, overlay Verify e `git diff --check`.

Checkpoint local consolidado em 2026-08-12, migration `0051`: disponibilidade operacional do
atendente passou a ser estado próprio por tenant, unidade e usuário, separado do lifecycle do
vínculo. A Inbox permite `AVAILABLE`, `PAUSED` e `OFFLINE`, capacidade máxima e pausa operacional,
com versão esperada, idempotência, reconciliação e horário local convertido para instante UTC
canônico. Claim, transferência e takeover falham fechado quando o destino está indisponível ou sem
capacidade; trabalho ativo impede pausa, saída ou redução incompatível. O seed OIDC restaura apenas
as identidades sintéticas operacionais como disponíveis e a jornada real altera disponibilidade com
duplo clique sem criar tráfego externo. Prova verde: 318/318 testes automatizados, 18/18 jornadas
E2E OIDC, banco limpo, upgrade legado com privilégios 0051 verificados, `typecheck:all`,
OpenAPI/cliente, `build:all`, overlay Verify e `git diff --check`.

Checkpoint local consolidado em 2026-08-12, migrations `0052`–`0054`: as fronteiras SQL de
disponibilidade revalidam contexto, tenant, conta, unidade e membership inclusive no replay; o
catálogo de transferência voltou a excluir papéis não operacionais. A Inbox ganhou uma projeção
ao vivo de alertas `MISSING_SLA`, `DUE_SOON` e `OVERDUE`, vinculada a unidade, filtros e relógio
congelado, com capacidade disponível derivada do estado operacional. Apenas o reconhecimento é
persistido, com versão do handoff, chave idempotente, replay reautorizado e audit único. Não existe
tabela materializada de alertas, cron, scheduler, mensagem, outbox de envio, Hermes ou Meta neste
corte. A política que define minutos de SLA continua pendente de regra de negócio e não foi
inventada; a ausência aparece explicitamente como `MISSING_SLA`. Prova verde: 330/330 testes
automatizados, 19/19 jornadas E2E OIDC no overlay reconstruído, banco limpo, upgrade legado,
`typecheck:all`, OpenAPI/cliente, `build:all`, overlay Verify e `git diff --check`.

1. Preservar o checkpoint local reproduzível: o controlador `local-oidc.ps1` já prova bootstrap
   vazio isolado, seed idempotente, descoberta/JWKS, login PKCE, RBAC, renovação, logout, restart
   e cleanup. O overlay não cria uma segunda API, frontend ou banco da aplicação.
2. O environment `oidc-homologation` está protegido no GitHub com reviewer obrigatório distinto,
   prevenção de autoaprovação, bypass administrativo desabilitado e deployments restritos à branch
   `main`. A própria branch `main` exige PR, o check `validate` atualizado, um approval, conversas
   resolvidas e histórico linear; administradores também estão sujeitos às regras, e force-push e
   deleção permanecem bloqueados. Preservar essas regras e não cadastrar valores sintéticos como
   configuração externa.
3. Publicar o mesmo artefato imutável em staging somente depois de o proprietário provisionar domínio
   HTTPS, IdP real, client público PKCE, redirects, variáveis públicas, segredos escopados e duas contas
   sintéticas exclusivas. Em seguida, executar a jornada real de navegador e registrar SHA, digests e
   execução como evidência. A Inbox canônica já está implementada até a migration `0051`; staging deve
   homologar esse mesmo artefato, sem criar uma segunda API, frontend, banco ou fluxo E2E paralelo.

Não ativar Hermes, transporte Meta real ou contas externas sem o gate e a autorização explícita da
fase correspondente. A interface local e a Inbox já estão implementadas e permanecem restritas ao
overlay sintético até homologação externa.
