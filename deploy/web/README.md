# Container web de staging

O `Dockerfile.web` produz o frontend estático e exige configuração OIDC HTTPS real no build. Não há
valor padrão de staging. Informe `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID` e
`VITE_OIDC_REDIRECT_URI`; os demais argumentos seguem os nomes documentados em `.env.example`.

Em runtime, informe:

- `API_UPSTREAM`: origin HTTP(S) interno da API, sem path ou credenciais;
- `OIDC_AUTHORITY_ORIGIN`: apenas o origin HTTPS da mesma authority usada no build.

O container escuta HTTP na porta `8080` como usuário não privilegiado. O proxy externo de staging é
responsável por TLS e deve preservar `X-Forwarded-Proto`. `/v1/*` é encaminhado para a API no mesmo
origin público. O healthcheck do container consulta `/health/web`; ele não substitui o healthcheck da API.

Arquivos com hash em `/assets/` usam cache imutável por um ano. Navegação SPA e `index.html` usam
`no-cache, no-store`; respostas da API não são armazenadas pelo Nginx.

