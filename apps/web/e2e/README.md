# Homologação OIDC real do shell

Este harness não cria usuários, tokens, servidor falso ou `storageState`. Ele só roda contra frontend,
API e provedor OIDC reais previamente configurados. Screenshots, vídeo e trace ficam desativados para
não persistir dados pessoais ou tokens.

Defina as variáveis somente no ambiente do processo, nunca em arquivo versionado:

- `E2E_OIDC_ENABLED=true`
- `E2E_BASE_URL=https://...`
- `E2E_ADMIN_USERNAME`, `E2E_ADMIN_PASSWORD`, `E2E_ADMIN_EXPECTED_TENANT`
- `E2E_ATTENDANT_USERNAME`, `E2E_ATTENDANT_PASSWORD`, `E2E_ATTENDANT_EXPECTED_TENANT`
- `E2E_MANAGER_USERNAME`, `E2E_MANAGER_PASSWORD`, `E2E_MANAGER_EXPECTED_TENANT`
- `E2E_MANAGER_MEMBERSHIP_MATCH`, identificador operacional de um vínculo que o gestor pode revogar e reativar
- seletores opcionais `E2E_OIDC_USERNAME_SELECTOR`, `E2E_OIDC_PASSWORD_SELECTOR` e
  `E2E_OIDC_SUBMIT_SELECTOR`

Quando o gate está habilitado, `E2E_BASE_URL` deve ser HTTPS e não pode conter credenciais. Variáveis
opcionais vazias são tratadas como ausentes; em especial, um `E2E_ATTENDANT_ADMIN_LIST_MATCH` vazio nunca
pode selecionar implicitamente a primeira conta administrativa.

Gates opcionais fail-closed:

- `E2E_REQUIRE_RENEWAL=true` torna a renovação obrigatória; nesse modo
  `E2E_RENEW_WAIT_SECONDS` ausente ou inválido falha o teste. A espera precisa atravessar o `expires_at`
  do token emitido no login, e o teste exige que a sessão passe a ter uma expiração posterior. Configure
  `E2E_OIDC_TEST_TIMEOUT_MS` com pelo menos a espera mais 15 segundos.
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

No GitHub, o workflow `OIDC external homologation` só aceita execução manual (`workflow_dispatch`) na
branch padrão. Ele não executa código de pull request com credenciais reais. Usa exclusivamente o
environment protegido `oidc-homologation` e falha fechado se variáveis, secrets, implantação HTTPS ou
contas não estiverem preparados.
