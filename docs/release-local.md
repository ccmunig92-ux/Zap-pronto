# Fechamento da release local

Este checklist transforma o estado validado no checkout canônico em uma evidência local reproduzível.
Ele não substitui o cronograma, não autoriza commit, push ou deploy e não homologa Meta, Hermes, IdP
externo ou produção.

## Escopo

- API, domínio, contratos, cliente gerado, web e banco do mesmo repositório canônico.
- Migrations append-only até `0050_handoff_reopen_latest_episode.sql`.
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
| `0006_outbox_worker.sql` | `0d438019d70f9bdd09027b4ef681a53cc8b2a1f85c658a791115bc9b7d59bf87` |
| `0049_handoff_reopen.sql` | `a8b81201c1c10960156c4b990aa36c81aa6a8ad7bb3cb0b7e5c8212ca512ef92` |
| `0050_handoff_reopen_latest_episode.sql` | `db810578003dfe112b571e37e03555c5f0a5d8ca6a6447362302cf8b125a0f65` |

Confira todas as migrations e preserve o resultado junto da evidência da execução:

```powershell
Get-FileHash database/migrations/*.sql -Algorithm SHA256
```

Não reescreva migrations publicadas. Qualquer correção de esquema posterior deve usar o próximo número
append-only e passar tanto pelo banco vazio quanto pelo upgrade legado.

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

Com todos os gates verdes, a declaração permitida é **candidato local validado**. Publicação exige um
snapshot deliberado e autorizado em branch/commit. Staging exige artefato imutável, IdP externo, HTTPS,
segredos escopados e homologação própria. Meta real, push e deploy permanecem proibidos sem autorização
explícita.
