# OIDC local integrado

Overlay local de `deploy/staging/compose.yaml`: adiciona somente Keycloak, seed sintético e borda TLS.
Segredos, URLs de banco, nonce de instância, marker do harness e certificados ficam exclusivamente em
`%LOCALAPPDATA%\ZapPronto\local-oidc-runtime` e `%LOCALAPPDATA%\ZapPronto\local-oidc-tls`, fora do
repositório. O marker não contém segredo; vincula caminho canônico do repo, project-name, nonce e hashes
dos dois Compose. Nunca copie esses arquivos para o workspace.
O valor `local-e2e-public-hmac-vector-v1` do overlay é um vetor público exclusivamente sintético para
callbacks locais assinados; ele nunca deve ser reutilizado como segredo Meta.
Não é configuração de produção e não substitui o gate com IdP externo.

- Senhas ficam em `.env.local` ignorado e são exclusivamente sintéticas.
- CA, certificado e chave ficam fora do repositório.
- Somente a borda publica uma porta em `127.0.0.1`.
- O client SPA usa Authorization Code com PKCE S256, sem secret e sem wildcard de redirect.
- A autorização continua no banco Zap Pronto; roles do Keycloak não concedem acesso ao produto.
- Cleanup usa os mesmos dois arquivos Compose e `down --volumes`; nunca use `docker system prune`.

## Ciclo local reproduzível

Pré-requisitos no host: PowerShell 7, Node.js 24 ou superior, Corepack e `pnpm`, Docker Desktop com
daemon e Compose disponíveis, Git for Windows instalado no caminho padrão (fornece o OpenSSL) e as
dependências congeladas do workspace:

    corepack enable
    pnpm install --frozen-lockfile
    pnpm --filter @zap-pronto/web exec playwright install chromium

O controlador valida esses requisitos antes de `Setup` alterar diretórios, ACLs, certificados ou o
trust store. `E2E` também falha antes do seed quando as dependências ou o Chromium não estão instalados.
Certificados ausentes, incompatíveis, sem o SAN exato ou com menos de sete dias de validade são gerados
em área temporária, validados contra a CA e as chaves e substituídos com rollback dos arquivos anteriores.

Na raiz do repositório, execute:

    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Setup
    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Up
    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action E2E

`Setup` cria secrets e certificados somente em `%LOCALAPPDATA%\ZapPronto` e confia a CA em
`CurrentUser\Root`. `Up` constrói os Dockerfiles canônicos, sobe os dois arquivos Compose e
executa `Verify`. `E2E` chama a suíte Playwright existente com renovação e revogação obrigatórias.
O harness também recria um atendimento sintético, faz um gestor assumir um atendimento ativo sob
supervisão e prova que somente a propriedade do handoff e da conversa muda: os estados permanecem
ativos, há um comando, um audit, um outbox e duas transições canônicas, sem mensagem outbound,
Hermes ou Meta. O fixture é restaurado depois da jornada.
Na sequência do encerramento e da leitura histórica, o harness usa o mesmo episódio sintético para provar
a reabertura unit-scoped pelo gestor. A operação preserva o handoff encerrado como histórico, cria exatamente
um novo handoff em `QUEUED`, reabre caso e conversa em `WAITING_HUMAN`/`HUMAN_QUEUED`, registra um comando,
um audit, um outbox e três transições `MANAGER_REOPENED`, sem outbound, Hermes ou Meta. O seed remove
deterministicamente todos os artefatos da reabertura antes de restaurar o agregado original.
Entre as jornadas, o harness recria uma entrada sintética `ROUTING_REQUIRED` em uma conexão corporativa
ambígua, valida o encaminhamento administrativo para a `Unidade Local`, a criação exclusiva do evento
canônico `channel.inbound.received` e a ausência de outbound, Hermes ou Meta. O seed é restaurado no
`finally`, inclusive quando a jornada falha.

Operações adicionais:

    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Verify
    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Down
    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Destroy
    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Untrust

`Down` preserva os volumes. `Destroy` remove somente os volumes do projeto Compose local.
`Untrust` remove somente a CA cuja origem, SHA-256, thumbprint e conteúdo coincidam com o marker.
Os gates locais não substituem a homologação posterior com IdP externo.
