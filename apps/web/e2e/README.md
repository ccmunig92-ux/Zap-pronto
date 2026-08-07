# Homologação OIDC real do shell

Este harness não cria usuários, tokens, servidor falso ou `storageState`. Ele só roda contra frontend,
API e provedor OIDC reais previamente configurados. Screenshots, vídeo e trace ficam desativados para
não persistir dados pessoais ou tokens.

Defina as variáveis somente no ambiente do processo, nunca em arquivo versionado:

- `E2E_OIDC_ENABLED=true`
- `E2E_BASE_URL=https://...`
- `E2E_ADMIN_USERNAME`, `E2E_ADMIN_PASSWORD`, `E2E_ADMIN_EXPECTED_TENANT`
- `E2E_ATTENDANT_USERNAME`, `E2E_ATTENDANT_PASSWORD`, `E2E_ATTENDANT_EXPECTED_TENANT`
- seletores opcionais `E2E_OIDC_USERNAME_SELECTOR`, `E2E_OIDC_PASSWORD_SELECTOR` e
  `E2E_OIDC_SUBMIT_SELECTOR`

Gates opcionais fail-closed:

- `E2E_REQUIRE_RENEWAL=true` torna a renovação obrigatória; nesse modo
  `E2E_RENEW_WAIT_SECONDS` ausente ou inválido falha o teste.
- `E2E_REQUIRE_BLOCK_REVOCATION=true` autoriza bloquear temporariamente a conta exclusiva do atendente,
  comprovar a perda de `/v1/me` em uma sessão já emitida e reativá-la obrigatoriamente no `finally`.
  Nunca use conta operacional ou compartilhada nesse gate. Se o username não for o e-mail mostrado na
  lista administrativa, forneça `E2E_ATTENDANT_ADMIN_LIST_MATCH` pelo mesmo cofre de segredos.

Execute `pnpm --filter @zap-pronto/web exec playwright install chromium` uma vez no host de teste e,
depois, `pnpm --filter @zap-pronto/web test:e2e:oidc`. Use contas exclusivas de homologação sem MFA
interativo. O teste de renovação permanece ignorado, a menos que `E2E_RENEW_WAIT_SECONDS` seja definido
de acordo com o TTL real e o frontend seja construído com refresh token homologado. O projeto não
habilita callback silencioso em iframe; não aponte um callback OIDC para uma página improvisada.

Não habilite screenshots, trace, vídeo ou reutilização de perfil. Não imprima variáveis de ambiente e
não copie diretórios de resultados para artefatos do CI.

No GitHub, o workflow `OIDC external homologation` pode ser executado antes do merge aplicando a label
`run-oidc-homologation` ao PR. Ele usa exclusivamente o environment protegido `oidc-homologation` e
falha fechado se variáveis, secrets, implantação HTTPS ou contas não estiverem preparados. Após o
workflow existir na branch padrão, `workflow_dispatch` continua disponível para novas homologações.
