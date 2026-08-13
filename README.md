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

O checkout canônico contém uma Inbox local integrada até a migration `0063`, com:

- autenticação OIDC, RBAC e isolamento por tenant e unidade;
- fila multiatendente, claim, devolução, transferência, takeover, encerramento, histórico e reabertura por novo episódio;
- prioridade, SLA, paginação keyset e filtros operacionais;
- administração de usuários e vínculos unitários;
- contratos TypeBox/OpenAPI, cliente gerado, PostgreSQL/RLS, audit e outbox;
- webhook Meta assinado e reconciliação sintética local, sem transporte outbound real.

Esse estado foi validado no overlay OIDC local. Ele **não** comprova staging ou produção, não conecta
contas Meta reais e mantém o transporte externo e Hermes desativados. O histórico de cortes e evidências
fica em [docs/cronograma.md](docs/cronograma.md); o procedimento reproduzível de fechamento local fica em
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
