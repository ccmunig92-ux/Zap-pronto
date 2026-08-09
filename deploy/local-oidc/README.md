# OIDC local integrado

Overlay local de `deploy/staging/compose.yaml`: adiciona somente Keycloak, seed sintético e borda TLS.
Não é configuração de produção e não substitui o gate com IdP externo.

- Senhas ficam em `.env.local` ignorado e são exclusivamente sintéticas.
- CA, certificado e chave ficam fora do repositório.
- Somente a borda publica uma porta em `127.0.0.1`.
- O client SPA usa Authorization Code com PKCE S256, sem secret e sem wildcard de redirect.
- A autorização continua no banco Zap Pronto; roles do Keycloak não concedem acesso ao produto.
- Cleanup usa os mesmos dois arquivos Compose e `down --volumes`; nunca use `docker system prune`.

## Ciclo local reproduzível

Na raiz do repositório, execute:

    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Setup
    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Up
    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action E2E

`Setup` cria secrets e certificados somente em `%LOCALAPPDATA%\ZapPronto` e confia a CA em
`CurrentUser\Root`. `Up` constrói os Dockerfiles canônicos, sobe os dois arquivos Compose e
executa `Verify`. `E2E` chama a suíte Playwright existente com renovação e revogação obrigatórias.

Operações adicionais:

    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Verify
    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Down
    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Destroy
    pwsh -NoProfile -File deploy/local-oidc/local-oidc.ps1 -Action Untrust

`Down` preserva os volumes. `Destroy` remove somente os volumes do projeto Compose local.
`Untrust` remove somente a CA cuja origem, SHA-256, thumbprint e conteúdo coincidam com o marker.
O gate 4/4 local não substitui a homologação posterior com IdP externo.
