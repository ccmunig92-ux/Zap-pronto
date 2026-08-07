# Staging containerizado

Este manifesto cria um Postgres próprio e persistente, executa migrations com uma credencial administrativa
separada, provisiona o login restrito `zap_pronto_runtime`, inicia a API e publica somente o web/proxy em
`127.0.0.1:${STAGING_HTTP_PORT}`. HTTPS deve terminar no Nginx do host; o banco e a API não publicam portas.

## Pré-condições

- `ZAP_API_IMAGE`, `ZAP_WEB_IMAGE` e `POSTGRES_IMAGE` apontam para imagens publicadas e fixadas por digest;
  o Postgres deve permanecer na linha 18.3 homologada pelo projeto.
- O web foi compilado com URLs HTTPS e client ID do mesmo IdP configurado na API.
- `OIDC_AUTHORITY_ORIGIN` contém somente o origin HTTPS da authority usada no build, sem path,
  credenciais, query ou fragmento; divergência faz o container web falhar fechado.
- Os três arquivos de secrets existem fora do checkout e são informados por caminhos absolutos. Como o
  Compose monta secrets de arquivo por bind mount, `postgres-password` deve pertencer ao UID/GID 70 da
  imagem PostgreSQL Alpine e as duas URLs ao UID/GID 1000 da imagem API, todos com modo `0400`; modo `0600`
  pertencente ao operador torna o secret ilegível para os containers não privilegiados.
- `database_migration_url` usa o owner do banco e nunca é reutilizado pela API.
- O usuário da migration URL precisa de `CREATEROLE` no primeiro boot para criar os roles de componente e
  o login runtime; na imagem oficial ele é o `POSTGRES_USER` inicial. Essa credencial não chega à API.
- `database_runtime_url` usa `zap_pronto_runtime` com senha não vazia. O provisionador valida que admin e
  runtime apontam ao mesmo banco, remove memberships e grants diretos residuais, recusa ownership/default
  privileges e confirma uma conexão real capaz de assumir somente `zap_pronto_api`.
- O password do owner contido na migration URL corresponde a `postgres_password`.

Nenhum valor secreto deve ser colocado no `.env`, na linha de comando, em labels ou no repositório.

## Critérios de aceite

1. `docker compose --env-file deploy/staging/.env -f deploy/staging/compose.yaml config --quiet` passa.
2. Apenas `web` possui `ports`, com `host_ip` igual a `127.0.0.1`; `postgres` e `api` não possuem portas.
3. `data` é uma rede interna e somente Postgres, migrator, provisionador e API participam dela.
4. `migrate` termina com sucesso antes do provisionador; API inicia somente após o provisionador terminar.
5. A conexão da API não é owner/superuser e consegue apenas assumir `zap_pronto_api`.
6. Todos os serviços persistentes ficam `healthy`; `/health/web` e `/health/live` respondem pelo listener web.
7. Reiniciar ou recriar os containers preserva o volume do Postgres e não reaplica migrations divergentes.
   No PostgreSQL 18 o volume cobre `/var/lib/postgresql`, conforme o layout versionado da imagem oficial.
8. Limites de CPU/memória, filesystem read-only, `no-new-privileges` e `cap_drop: ALL` aparecem na configuração
   renderizada para todos os serviços aos quais se aplicam.
9. O Nginx do host encaminha HTTPS somente ao loopback configurado, sem publicar diretamente a porta interna.
10. A rotação local do driver de logs limita cada serviço a cinco arquivos de 10 MB; a retenção externa deve
    ser definida antes de produção.
