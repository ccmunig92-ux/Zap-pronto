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
- Os quatro arquivos de secrets existem fora do checkout e são informados por caminhos absolutos. Como o
  Compose monta secrets de arquivo por bind mount, `postgres-password` deve pertencer ao UID/GID 70 da
  imagem PostgreSQL Alpine e as três URLs (`database_migration_url`, `database_runtime_url` e
  `database_worker_url`) ao UID/GID 1000 da imagem API, todos com modo `0400`; modo `0600`
  pertencente ao operador torna o secret ilegível para os containers não privilegiados.
- `database_migration_url` usa o owner do banco e nunca é reutilizado pela API.
- O usuário da migration URL precisa de `CREATEROLE` no primeiro boot para criar os roles de componente e
  o login runtime; na imagem oficial ele é o `POSTGRES_USER` inicial. Essa credencial não chega à API.
- `database_runtime_url` usa `zap_pronto_runtime` com senha não vazia. `database_worker_url` usa
  `zap_pronto_worker_runtime`, separado da API e autorizado somente a assumir `zap_pronto_worker`. O provisionador valida que admin e
  runtime apontam ao mesmo banco, remove memberships e grants diretos residuais, recusa ownership/default
  privileges e confirma uma conexão real capaz de assumir somente `zap_pronto_api`.
- O password do owner contido na migration URL corresponde a `postgres_password`.

Nenhum valor secreto deve ser colocado no `.env`, na linha de comando, em labels ou no repositório.

## Imagens publicadas

O workflow manual `Publish staging images` só executa na branch padrão e no environment
`oidc-homologation`. Ele exige as variáveis públicas `OIDC_ISSUER`, `OIDC_WEB_CLIENT_ID`,
`OIDC_WEB_REDIRECT_URI` e `OIDC_WEB_POST_LOGOUT_REDIRECT_URI`, publica API e web no GHCR com SBOM,
gera attestations de proveniência, bloqueia vulnerabilidades críticas conhecidas e registra no resumo as referências imutáveis `repo@sha256`.
Copie somente essas referências para o `.env` externo de staging; tags por SHA não substituem o digest.
O job permanece ignorado enquanto um administrador não definir `STAGING_RELEASE_ENABLED=true` no environment;
essa variável só deve ser criada depois de configurar reviewer obrigatório e política restrita à `main`.

## Critérios de aceite

Antes de iniciar o stack, execute `node scripts/staging-preflight.mjs /caminho/absoluto/staging.env`.
O comando não imprime nem lê o conteúdo dos secrets; exige imagens por digest, arquivos fora do repositório
com a matriz `70:70/0400` para PostgreSQL e `1000:1000/0400` para API, endpoints OIDC HTTPS coerentes e os
limites mínimos do manifesto. A validação operacional de owner/mode exige um host POSIX.

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

## Objetivos operacionais de staging

Até existir medição de produção, staging adota objetivos conservadores, não SLOs contratuais:

- RPO máximo de 24 horas, com backup diário externo ao host e retenção mínima de 14 dias;
- RTO máximo de 4 horas, contado da declaração do incidente até o serviço verificado;
- restore drill antes de cada promoção e ao menos mensalmente enquanto o ambiente estiver ativo;
- nenhum backup é considerado válido sem restauração em banco isolado e verificação das migrations.

O primeiro exercício real deve registrar duração, tamanho, SHA do artefato e local imutável do backup.
Se RPO ou RTO não forem comprovados, staging permanece bloqueado para homologação.
