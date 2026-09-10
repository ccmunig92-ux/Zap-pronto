# Primeiro provisionamento de arquivos de credenciais

O script `scripts/staging-init-database-secrets.mjs` cria quatro arquivos canônicos
em `/srv/zap-pronto/secrets/staging`, exclusivamente como root no Linux. O diretório
deve existir, pertencer a root e ter modo 0700; ancestrais não podem ser symlinks
nem permitir escrita por grupo/outros. As credenciais são geradas no servidor com
32 bytes aleatórios para cada papel. Nunca são impressas ou enviadas ao Windows.

Execute apenas para um banco novo, antes de criar o volume do PostgreSQL. Não é
uma ferramenta de rotação nem recuperação de senha de banco existente.
Arquivos existentes e execuções concorrentes são recusados. Em erro parcial,
os arquivos criados são preservados; não os apague nem repita sem revisão.

No PowerShell local (solicita a senha SSH no terminal):

```powershell
Get-Content -Raw -LiteralPath 'C:\Users\Meu Computador\Zap-pronto-local\scripts\staging-init-database-secrets.mjs' | ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=yes -o ConnectTimeout=10 zap-pronto-staging 'node --input-type=module - --apply'
```

Sucesso: `DATABASE_SECRET_FILES_CREATED; NO_DATABASE_STARTED; NO_MIGRATIONS_APPLIED`.
Os quatro arquivos usam modo 0400: `postgres-password` com UID/GID 70 e
`database-migration-url`, `database-runtime-url`, `database-worker-url` com 1000.
As URLs apontam ao serviço interno `postgres:5432`, banco `zap_pronto`, owner
`zap_pronto_owner`, runtime `zap_pronto_runtime` e worker `zap_pronto_worker_runtime`.
O futuro `compose.env` deve usar exatamente esses nomes de banco/papéis/caminhos.

Esta etapa não cria `compose.env`, imagens, banco, migrations, HTTPS ou secrets Meta. O staging base pode
subir sem Meta; o override `compose.meta.yaml` continua bloqueado até receber credenciais Meta reais.
O preflight completo continua obrigatório antes de iniciar qualquer container.
