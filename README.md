# Zap Pronto

Plataforma SaaS omnichannel, multiempresa, multiunidade e multiusuário para atendimento humano e assistido por agentes.

## Invariantes

- A plataforma possui banco e ciclo de vida próprios.
- Uma conexão de WhatsApp, Instagram ou Facebook pode atender várias unidades.
- Vários atendentes compartilham a inbox; somente um humano responde por conversa por vez.
- Hermes é runtime conversacional, não banco, CRM, agenda ou motor de preço.
- Sem integração de agenda homologada, o agente coleta, confirma e transfere para humano.
- Coleta concluída, problema ou pedido por humano sempre resultam em handoff.
- Takeover humano suspende a automação.
- Preço exige unidade e versão de tabela.
- Integrações externas são opcionais e passam por contratos idempotentes.

## Estado atual

O candidato local contém uma Inbox validada até a migration `0080`. O conjunto inclui:

- autenticação OIDC, RBAC e isolamento por tenant e unidade;
- fila multiatendente, claim, devolução, transferência, takeover, encerramento, histórico e reabertura por novo episódio;
- prioridade, SLA, paginação keyset e filtros operacionais;
- administração de usuários e vínculos unitários;
- contratos TypeBox/OpenAPI, cliente gerado, PostgreSQL/RLS, audit e outbox;
- webhook Meta assinado e reconciliação sintética local, sem transporte outbound real.
- administração tenant-aware de conexões de canal, com escopo corporativo/multiunidade,
  idempotência e apenas `secret_reference` como apontador opaco para segredo externo;
- episódios versionados de alerta de capacidade, leitura/acknowledgement protegidos por RBAC e
  stream SSE da Inbox com payload somente de identificadores;
- escalas vinculadas causalmente à versão exata do fuso e invalidadas de forma fail-closed quando ele muda;
- disponibilidade restaurada como `OFFLINE` após reativação de vínculo.
- convergência automática near-real-time da Inbox por leituras periódicas dos contratos existentes,
  sem push, WebSocket, endpoint ou persistência paralelos.
- alerta agregado opt-in de demanda sustentada quando há capacidade operacional, configurado no
  módulo de SLA e lido no refresh canônico da Inbox, sem ranking individual nem envio externo.
- descoberta dinâmica e paginada das políticas de alerta habilitadas, isolada por tenant e exclusiva
  do worker, sem lista estática de unidades nem acesso direto às tabelas protegidas.

As migrations `0068`–`0080` são incrementos canônicos desse mesmo fluxo; não representam uma segunda
aplicação ou um contrato paralelo.

Esse estado foi validado no overlay OIDC local e em staging HTTPS. A homologação OIDC externa da `main`
no SHA `9f1901a9caf1b58ad413d166bb4920c82a537756` comprovou as jornadas reais de administrador,
atendente/RBAC, renovação de token, bloqueio com invalidação da sessão, reativação e recuperação
idempotente no run `34563529651`. O proxy `/v1` publicado na Vercel preserva o contrato da API e responde
`401 application/problem+json` sem token. Essa evidência **não** habilita contas Meta reais nem Hermes,
que permanecem desativados. O histórico de cortes e evidências fica em
[docs/cronograma.md](docs/cronograma.md); o procedimento reproduzível de fechamento local fica em
[docs/release-local.md](docs/release-local.md).

## Desenvolvimento local

Pré-requisitos: Node.js 24, pnpm 11.9, Docker com Compose e PowerShell 7 no Windows para o controlador
OIDC local.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck:all
pnpm test:all
pnpm api:check
pnpm build:all
```

O banco de integração exige PostgreSQL 18 e `DATABASE_ADMIN_URL`. O overlay completo é controlado pelo
script existente, sem criar uma segunda aplicação:

```powershell
pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Up
pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Verify
pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action E2E
```

Não execute deploy nem habilite Meta/Hermes a partir deste README. Essas fases exigem autorização e
homologação externas explícitas.
