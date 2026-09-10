# Container web de staging

O `Dockerfile.web` produz o frontend estático e exige configuração OIDC HTTPS real no build. Não há
valor padrão de staging. Informe `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID` e
`VITE_OIDC_REDIRECT_URI`; os demais argumentos seguem os nomes documentados em `.env.example`.

Para Auth0, configure `VITE_OIDC_AUDIENCE` no build com o Identifier da API registrada,
exatamente igual a `OIDC_AUDIENCE` do backend. O workflow de imagens recebe esse valor
da variável pública `OIDC_AUDIENCE` do environment `oidc-homologation`.
Na Vercel, configure `VITE_OIDC_AUDIENCE` no ambiente de build e gere um novo deployment.
Não use o Client ID da SPA como substituto do Identifier da API e não insira client secrets
em variáveis `VITE_*`. A configuração é opcional para outros provedores que atribuem a
audiência por mapeamento no servidor; ela não desabilita a validação de audiência da API.
Login só está homologado após um token real acessar `/v1/me` com tenant e permissões corretos.

Em runtime, informe:

- `API_UPSTREAM`: origin HTTP(S) interno da API, sem path ou credenciais;
- `OIDC_AUTHORITY_ORIGIN`: apenas o origin HTTPS da mesma authority usada no build.

O container escuta HTTP na porta `8080` como usuário não privilegiado. O proxy externo de staging é
responsável por TLS e deve preservar `X-Forwarded-Proto`. `/v1/*` é encaminhado para a API no mesmo
origin público. O healthcheck do container consulta `/health/web`; ele não substitui o healthcheck da API.
O listener também encaminha somente `/health/live` para a API. `/health/ready` permanece interno à rede
Docker e responde `404` no frontend público.

Arquivos com hash em `/assets/` usam cache imutável por um ano. Navegação SPA e `index.html` usam
`no-cache, no-store`; respostas da API não são armazenadas pelo Nginx.
O access log registra apenas o path normalizado, nunca query string ou `Referer`, para não persistir
`code` e `state` do callback OIDC. O upstream usa o resolver DNS interno do Docker com TTL curto, de modo
que a recriação da API não exige reiniciar o web.
