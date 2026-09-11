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
- Por padrão a API lê `email` e `email_verified` do access token. Para um IdP que publica e-mail
  verificado em claims namespaced, defina obrigatoriamente o par `OIDC_EMAIL_CLAIM` e
  `OIDC_EMAIL_VERIFIED_CLAIM` como URIs HTTPS distintas, sem credenciais, query, fragmento ou espaços.
  Exemplo: `https://clinicaprontomedic.online/claims/email` e
  `https://clinicaprontomedic.online/claims/email_verified`.
- Não configure explicitamente `email`/`email_verified`: deixe ambas as variáveis ausentes para usar o
  padrão. Pares padrão explícitos e pares híbridos padrão/namespaced falham fechados. O preflight compara
  o par de origem exatamente com o ambiente da API renderizado pelo Compose e rejeita ausência ou deriva.
- O primeiro claim precisa ser string e o segundo precisa ser o booleano JSON `true`. String `"true"`,
  claim ausente ou os claims padrão quando o par namespaced está configurado não autorizam aceitação
  de convite.
- No Auth0, uma Post Login Action deve adicionar esse par somente ao **access token** destinado ao
  Identifier exato da API. Não envie esses dados apenas no ID token e não use `/userinfo`, corpo da
  requisição ou Management API como fallback. Tokens emitidos antes da Action precisam ser renovados.
- Os quatro arquivos de secrets do banco existem fora do checkout e são informados por caminhos absolutos. Como o
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
- O manifesto base mantém webhook e envio Meta desabilitados e não exige secrets Meta. Para habilitar ambos,
  adicione `-f deploy/staging/compose.meta.yaml` a todos os comandos Compose e execute o preflight com `--meta`.
  `META_WHATSAPP_SECRET_ROOT` é um diretório absoluto fora do checkout. O Compose o monta somente como
  bind read-only no worker em `/run/zap-pronto-secrets/meta`; o diretório deve ser regular, sem symlink,
  pertencer a UID/GID `1000:1000` e usar modo `0750`. Cada arquivo deve seguir
  `<tenantId>/<channelConnectionId>/<secret_reference>`. O worker permanece desabilitado até esse diretório
  conter referências reais provisionadas pelo operador; nenhum token é lido do `.env`.
- No override Meta, `META_WEBHOOK_ENABLED` e `OUTBOUND_WORKER_ENABLED` ficam `true`. O operador deve criar os arquivos
  externos `META_APP_SECRET_FILE` e `META_VERIFY_TOKEN_FILE`, ambos com modo `0400`, pertencentes ao UID/GID
  1000 da imagem API. O Compose os monta apenas na API em `/run/secrets/meta_app_secret` e
  `/run/secrets/meta_verify_token`; nenhum segredo aparece no `.env`, logs ou imagem.

Nenhum valor secreto deve ser colocado no `.env`, na linha de comando, em labels ou no repositório.

## Bootstrap do primeiro administrador

O primeiro tenant não pode usar o fluxo normal de convites porque ainda não existe um administrador.
Crie `/srv/zap-pronto/secrets/staging/initial-bootstrap.json` fora do checkout, pertencente a
`1000:1000`, modo `0400`, com exatamente estas chaves (valores abaixo são apenas marcadores):

```json
{
  "tenantId": "UUID_GERADO_OFFLINE",
  "tenantName": "NOME_DO_TENANT",
  "unitId": "UUID_GERADO_OFFLINE",
  "unitCode": "MATRIZ",
  "unitName": "NOME_DA_UNIDADE",
  "adminUserId": "UUID_GERADO_OFFLINE",
  "adminEmail": "EMAIL_VERIFICADO_NO_IDP",
  "adminDisplayName": "NOME_DO_ADMIN",
  "oidcProviderId": "UUID_GERADO_OFFLINE",
  "oidcProviderCode": "auth0",
  "oidcIssuer": "https://TENANT_DO_IDP/",
  "oidcAudience": "zap-pronto",
  "oidcOrganizationClaim": null,
  "oidcOrganizationValue": null,
  "oidcConfigReference": "auth0://TENANT/APLICACAO",
  "oidcSubject": "SUB_EXATO_DO_TOKEN"
}
```

Com o Postgres saudável e após `migrate`, execute uma única vez:

```sh
docker compose --env-file /srv/zap-pronto/secrets/staging/compose.env \
  -f /opt/Zap-pronto/deploy/staging/compose.yaml run --rm --no-deps \
  --volume /srv/zap-pronto/secrets/staging/initial-bootstrap.json:/run/secrets/initial-bootstrap.json:ro \
  --env BOOTSTRAP_CONFIG_FILE=/run/secrets/initial-bootstrap.json \
  migrate node scripts/staging-bootstrap-tenant.mjs --apply
```

A referência `oidcConfigReference` é somente um localizador opaco não secreto no formato
`esquema://identificador/caminho`; usuário, senha, `@`, query, fragmento, espaços e caracteres de
controle são recusados. Não coloque client secret, token ou senha nesse campo.

O serviço `migrate` recebe `OIDC_ISSUER`, `OIDC_AUDIENCE` e `OIDC_ORGANIZATION_CLAIM` do mesmo
`compose.env` usado pela API. Antes de abrir conexão ou executar SQL, o comando exige igualdade exata
entre issuer, audience e organization claim do JSON e a configuração OIDC efetiva; claim vazio no
ambiente corresponde a `null` no JSON. Assim, um bootstrap preparado para outro IdP falha fechado.

A credencial administrativa vem somente de `/run/secrets/database_migration_url`. A operação recusa
banco parcialmente povoado, não corrige cadastros existentes e só admite repetição com configuração
idêntica e estado persistido integralmente inalterado. Depois de `INITIAL_TENANT_BOOTSTRAPPED`, remova
o arquivo de configuração do host; ele contém identificadores pessoais, embora não contenha senha nem
client secret.

## Imagens publicadas

O workflow manual `Publish staging images` só executa na branch padrão e no environment
`oidc-homologation`. Ele exige as variáveis públicas `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_WEB_CLIENT_ID`,
`OIDC_WEB_REDIRECT_URI` e `OIDC_WEB_POST_LOGOUT_REDIRECT_URI`, publica API e web no GHCR com SBOM,
gera attestations de proveniência, bloqueia vulnerabilidades críticas conhecidas e registra no resumo as referências imutáveis `repo@sha256`.
Copie somente essas referências para o `.env` externo de staging; tags por SHA não substituem o digest.
Antes de promover cada digest, verifique sua attestation com `gh attestation verify oci://<imagem@sha256> --repo ccmunig92-ux/Zap-pronto --signer-workflow ccmunig92-ux/Zap-pronto/.github/workflows/staging-images.yml` autenticado no GHCR.
O job permanece ignorado enquanto um administrador não definir `STAGING_RELEASE_ENABLED=true` como variável do repositório;
essa variável só deve ser criada depois de configurar no environment o reviewer obrigatório e a política restrita à `main`.

## Homologação OIDC externa e recuperação da conta dedicada

O workflow manual `OIDC external homologation` aceita os modos `homologate` e `recover-only`. Configure
`E2E_ATTENDANT_ADMIN_LIST_MATCH` como o e-mail completo da conta de atendente dedicada; correspondência
parcial, nome de exibição e identificador ambíguo são recusados. Essa conta não pode ser usada por uma
pessoa ou integração operacional enquanto a homologação estiver habilitada.
As execuções usam um grupo de concorrência único e nunca cancelam automaticamente a execução ativa, para
que duas homologações não alterem simultaneamente a mesma conta.

O modo completo reativa a conta de teste antes da mutação, bloqueia-a apenas para comprovar a invalidação
da sessão e tenta reativá-la novamente em uma etapa `always`. Cancelamento forçado, perda do runner ou
esgotamento do timeout ainda podem impedir a limpeza. Nesse caso, execute imediatamente o mesmo workflow
em `recover-only`, aprove a execução no environment protegido e confirme o sucesso antes de reutilizar a
conta ou iniciar outra homologação. Nunca recupere automaticamente uma conta operacional real.

## Critérios de aceite

Antes de iniciar o stack base, execute `node scripts/staging-preflight.mjs /caminho/absoluto/staging.env`.
Para o stack com Meta, execute `node scripts/staging-preflight.mjs /caminho/absoluto/staging.env --meta`.
O comando não imprime nem lê o conteúdo dos secrets; exige imagens por digest, arquivos fora do repositório
com a matriz `70:70/0400` para PostgreSQL e `1000:1000/0400` para API, endpoints OIDC HTTPS coerentes e os
limites mínimos do manifesto. A árvore Meta também é validada fora do checkout (`1000:1000/0750`, sem symlinks).
A validação operacional de owner/mode exige um host POSIX.

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
