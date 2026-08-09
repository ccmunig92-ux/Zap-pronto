# OIDC local integrado

Overlay local de `deploy/staging/compose.yaml`: adiciona somente Keycloak, seed sintético e borda TLS.
Não é configuração de produção e não substitui o gate com IdP externo.

- Senhas ficam em `.env.local` ignorado e são exclusivamente sintéticas.
- CA, certificado e chave ficam fora do repositório.
- Somente a borda publica uma porta em `127.0.0.1`.
- O client SPA usa Authorization Code com PKCE S256, sem secret e sem wildcard de redirect.
- A autorização continua no banco Zap Pronto; roles do Keycloak não concedem acesso ao produto.
- Cleanup usa os mesmos dois arquivos Compose e `down --volumes`; nunca use `docker system prune`.
