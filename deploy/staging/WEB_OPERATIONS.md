# Operação e rollback do web/proxy

Este runbook cobre somente o container `web`. Não altera API, banco, migrations, volumes, secrets ou
backup. Execute no host de staging a partir do checkout correspondente ao manifesto implantado.

## Verificação pós-deploy

Use uma URL pública HTTPS real para validar também o terminador TLS do host:

```sh
sh deploy/staging/verify-web.sh --env-file /caminho/seguro/staging.env \
  --public-url https://HOST-DE-STAGING
```

O gate falha se o container não estiver saudável, se `/health/web` ou `/health/live` falharem, se
`/health/ready` ficar público, se CSP/cache estiverem incorretos ou se houver erro crítico recente do
Nginx. Também recusa imagem ativa referenciada por tag mutável. A saída registra imagem ativa, restart count e quantidade de respostas 5xx nos últimos cinco
minutos. Não registra headers de autenticação, query strings ou conteúdo de secrets.

Depois do deploy, acompanhe por pelo menos quinze minutos:

```sh
docker compose --env-file /caminho/seguro/staging.env -f deploy/staging/compose.yaml ps
docker compose --env-file /caminho/seguro/staging.env -f deploy/staging/compose.yaml logs \
  --since 15m --follow web
```

Interrompa a liberação se o health oscilar, o restart count aumentar, surgirem erros `emerg/alert/crit`
ou respostas 5xx persistentes. Um 5xx isolado é reportado para investigação, mas o script não tenta
diagnosticar nem reiniciar a API.

## Rollback do web

Identifique previamente o digest da última imagem web homologada. Tags mutáveis são recusadas. O host
precisa do GitHub CLI autenticado: antes do pull, o script valida a provenance contra o workflow
`ccmunig92-ux/Zap-pronto/.github/workflows/staging-images.yml` e rejeita runners auto-hospedados.

```sh
sh deploy/staging/rollback-web.sh \
  --previous-image REGISTRY/IMAGEM@sha256:DIGEST-ANTERIOR \
  --env-file /caminho/seguro/staging.env \
  --public-url https://HOST-DE-STAGING
```

O comando baixa a imagem, recria somente `web` com `--no-deps`, aguarda o healthcheck e executa toda a
verificação pós-deploy. Se a imagem anterior não subir ou não passar nos gates, tenta restaurar a imagem
que estava ativa. Após sucesso, atualize de forma atômica o `ZAP_WEB_IMAGE` no arquivo externo de staging;
caso contrário, uma futura operação do Compose pode reaplicar a imagem que sofreu rollback.

Rollback do web não corrige incompatibilidade de contrato da API. Se a versão anterior do frontend não
for compatível com a API ativa, mantenha a operação bloqueada e siga o runbook de rollback integrado.
