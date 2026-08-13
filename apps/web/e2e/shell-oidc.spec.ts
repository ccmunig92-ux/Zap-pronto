import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const enabled = process.env.E2E_OIDC_ENABLED === "true";
const requireRenewal = process.env.E2E_REQUIRE_RENEWAL === "true";
const requireBlockRevocation = process.env.E2E_REQUIRE_BLOCK_REVOCATION === "true";
const optional = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const target = optional("E2E_OIDC_TARGET");
const localMode = target === "local";
const externalMode = target === "external";
const testTimeoutMs = Number(optional("E2E_OIDC_TEST_TIMEOUT_MS") ?? 90_000);
const usernameSelector = optional("E2E_OIDC_USERNAME_SELECTOR") ?? 'input[name="username"]';
const passwordSelector = optional("E2E_OIDC_PASSWORD_SELECTOR") ?? 'input[name="password"]';
const submitSelector = optional("E2E_OIDC_SUBMIT_SELECTOR") ?? 'button[type="submit"]';

if (enabled) {
  if (!localMode && !externalMode) throw new Error("E2E_OIDC_TARGET_LOCAL_OR_EXTERNAL_REQUIRED");
  const baseUrl = optional("E2E_BASE_URL");
  let parsed: URL;
  try { parsed = new URL(baseUrl ?? ""); } catch { throw new Error("E2E_BASE_URL_VALID_HTTPS_REQUIRED"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("E2E_BASE_URL_VALID_HTTPS_REQUIRED");
  }
  if(localMode&&(process.env.E2E_LOCAL_DESTRUCTIVE_ALLOWED!=="true"||parsed.origin!=="https://zap-pronto.127.0.0.1.nip.io:18443"
    ||!process.env.E2E_LOCAL_INSTANCE_NONCE?.match(/^[A-Za-z0-9_-]{32,128}$/)
    ||process.env.E2E_ADMIN_USERNAME!=="admin.local"||process.env.E2E_ATTENDANT_USERNAME!=="attendant.local"
    ||process.env.E2E_ATTENDANT_TWO_USERNAME!=="attendant.two.local"
    ||process.env.E2E_MANAGER_USERNAME!=="attendant.two.local")){
    throw new Error("E2E_LOCAL_HARNESS_AUTHORIZATION_REQUIRED");
  }
  if(externalMode&&(process.env.E2E_LOCAL_DESTRUCTIVE_ALLOWED==="true"
    ||parsed.origin==="https://zap-pronto.127.0.0.1.nip.io:18443"
    ||parsed.hostname==="localhost"||parsed.hostname==="127.0.0.1"||parsed.hostname==="::1")){
    throw new Error("E2E_EXTERNAL_HARNESS_PUBLIC_ORIGIN_REQUIRED");
  }
  if(externalMode&&requireBlockRevocation&&process.env.E2E_EXTERNAL_ACCOUNT_BLOCK_ALLOWED!=="true"){
    throw new Error("E2E_EXTERNAL_ACCOUNT_BLOCK_ALLOWED_REQUIRED");
  }
}

if (requireRenewal) {
  if (!enabled) throw new Error("E2E_OIDC_ENABLED_REQUIRED_FOR_RENEWAL");
  const configuredWait = process.env.E2E_RENEW_WAIT_SECONDS;
  if (!configuredWait || !/^\d+$/.test(configuredWait) || Number(configuredWait) <= 0
    || !Number.isSafeInteger(Number(configuredWait))) {
    throw new Error("E2E_RENEW_WAIT_SECONDS_VALID_POSITIVE_INTEGER_REQUIRED");
  }
  if (!Number.isSafeInteger(testTimeoutMs) || testTimeoutMs < (Number(configuredWait) + 15) * 1000) {
    throw new Error("E2E_OIDC_TEST_TIMEOUT_MUST_EXCEED_RENEW_WAIT_BY_15_SECONDS");
  }
}
if (requireBlockRevocation && !enabled) {
  throw new Error("E2E_OIDC_ENABLED_REQUIRED_FOR_BLOCK_REVOCATION");
}

interface AccountConfiguration { username: string; password: string; tenant: string }
function account(prefix: "ADMIN" | "ATTENDANT" | "ATTENDANT_TWO" | "MANAGER"): AccountConfiguration {
  const username = process.env[`E2E_${prefix}_USERNAME`];
  const password = process.env[`E2E_${prefix}_PASSWORD`];
  const tenant = process.env[`E2E_${prefix}_EXPECTED_TENANT`];
  if (!username || !password || !tenant) throw new Error(`E2E_${prefix}_CONFIGURATION_REQUIRED`);
  return { username, password, tenant };
}

async function login(page: Page, configuration: AccountConfiguration): Promise<void> {
  await page.goto("/");
  const enter = page.getByRole("button", { name: "Entrar" });
  await expect(enter).toBeEnabled();
  const me = page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/me"
    && response.request().method() === "GET" && response.status() === 200);
  await enter.click();
  await page.locator(usernameSelector).fill(configuration.username);
  await page.locator(passwordSelector).fill(configuration.password);
  await page.locator(submitSelector).click();
  const response = await me;
  expect(response.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { name: configuration.tenant })).toBeVisible();
}

async function openModule(page: Page, name: "Acessos" | "Roteamento" | "Vínculos" | "Visão geral"): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "Módulos" });
  const button = navigation.getByRole("button", { name });
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-current", "page");
}

async function oidcAccessTokenExpiration(page: Page): Promise<number> {
  return page.evaluate(() => {
    const expirations = Object.keys(sessionStorage).filter((key) => key.startsWith("oidc.user:"))
      .map((key) => {
        try {
          const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as { expires_at?: unknown } | null;
          return typeof value?.expires_at === "number" ? value.expires_at : undefined;
        } catch { return undefined; }
      }).filter((value): value is number => value !== undefined);
    if (expirations.length !== 1) throw new Error("SINGLE_OIDC_ACCESS_TOKEN_EXPIRATION_REQUIRED");
    return expirations[0]!;
  });
}

async function userRow(page: Page, privateIdentifier: string) {
  const heading = page.getByRole("heading", { name: "Usuários" });
  await expect(heading).toBeVisible();
  const list = heading.locator("xpath=following-sibling::ul[1]");
  const rows = list.locator("li");
  for (;;) {
    const index = await rows.evaluateAll((elements, identifier) => elements.findIndex((element) =>
      element.textContent?.includes(identifier)), privateIdentifier);
    if (index >= 0) return rows.nth(index);
    const more = page.getByRole("button", { name: "Carregar mais usuários" });
    if (await more.count() === 0) throw new Error("ATTENDANT_USER_ROW_NOT_FOUND");
    const previousCount = await rows.count();
    await more.click();
    await expect(rows).not.toHaveCount(previousCount);
  }
}

async function reactivateAttendant(page: Page, privateIdentifier: string): Promise<void> {
  const users = page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/users"
    && response.request().method() === "GET");
  const invitations = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/v1/users/invitations"
    && response.request().method() === "GET");
  await page.goto("/");
  await openModule(page, "Acessos");
  const [usersResponse, invitationsResponse] = await Promise.all([users, invitations]);
  expect(usersResponse.status(), "A recuperação precisa recarregar usuários administrativos").toBe(200);
  expect(invitationsResponse.status(), "A recuperação precisa recarregar convites administrativos").toBe(200);
  await expect(page.getByRole("heading", { name: "Administração de acesso" })).toBeVisible();
  const row = await userRow(page, privateIdentifier);
  const reactivate = row.getByRole("button", { name: "Reativar" });
  if (await reactivate.count() === 0) return;
  await reactivate.click();
  await page.getByLabel("Motivo").fill("Limpeza obrigatória da homologação OIDC");
  await page.getByRole("button", { name: "Confirmar reativar" }).click();
  await expect((await userRow(page, privateIdentifier)).getByRole("button", { name: "Bloquear" })).toBeVisible();
}

test.describe("shell OIDC real", () => {
  test("administrador autentica, recebe /v1/me, vê RBAC e encerra a sessão", async ({ page }) => {
    test.skip(!enabled, "Defina E2E_OIDC_ENABLED=true e forneça a configuração externa documentada.");
    await login(page, account("ADMIN"));
    await openModule(page, "Acessos");
    await expect(page.getByRole("heading", { name: "Administração de acesso" })).toBeVisible();
    await page.getByRole("button", { name: "Sair" }).click();
    await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
    const oidcUserKeys = await page.evaluate(() => Object.keys(sessionStorage)
      .filter((key) => key.startsWith("oidc.user:"))).catch(() => [] as string[]);
    expect(oidcUserKeys).toHaveLength(0);
  });

  test("admin encaminha entrada sem unidade", async ({ page }) => {
    test.skip(!enabled, "Defina E2E_OIDC_ENABLED=true para homologar o roteamento local.");
    await login(page, account("ADMIN"));
    await openModule(page, "Roteamento");
    const mutations: string[] = [];
    const resolvePosts: string[] = [];
    const externalHosts: string[] = [];
    const metaRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname !== "zap-pronto.127.0.0.1.nip.io") externalHosts.push(url.host);
      if (url.pathname.startsWith("/v1/") && ["POST", "PATCH", "PUT", "DELETE"].includes(request.method())) {
        mutations.push(`${request.method()} ${url.pathname}`);
      }
      if (request.method() === "POST" && /^\/v1\/inbox\/routing-required\/[^/]+\/resolve$/u.test(url.pathname)) {
        resolvePosts.push(url.pathname);
      }
      if (url.pathname === "/v1/webhooks/meta" || url.hostname.includes("facebook") || url.hostname.includes("meta")) {
        metaRequests.push(`${request.method()} ${url.href}`);
      }
    });
    await page.reload();
    const heading = page.getByRole("heading", { name: "Aguardando unidade" });
    await expect(heading).toBeVisible();
    const panel = heading.locator("xpath=ancestor::section[1]");
    const routableItems = panel.getByRole("listitem").filter({
      has: page.getByRole("button", { name: "Encaminhar para unidade" }),
    });
    await expect(routableItems).toHaveCount(1);
    const item = routableItems.first();
    await item.getByRole("combobox", { name: /^Unidade para /u }).selectOption({ label: "Unidade Local" });
    const resolved = page.waitForResponse((response) => response.request().method() === "POST"
      && /^\/v1\/inbox\/routing-required\/[^/]+\/resolve$/u.test(new URL(response.url()).pathname));
    await item.getByRole("button", { name: "Encaminhar para unidade" })
      .evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
    expect((await resolved).status()).toBe(200);
    await expect(routableItems).toHaveCount(0);
    await expect(panel.getByText("Nenhum atendimento aguardando unidade.")).toBeVisible();
    expect(resolvePosts).toHaveLength(1);
    expect(mutations).toEqual([`POST ${resolvePosts[0]}`]);
    expect(metaRequests).toEqual([]);
    expect(externalHosts).toEqual([]);
  });

  test("atendente autentica e não recebe controles administrativos", async ({ page }) => {
    test.skip(!enabled, "Defina E2E_OIDC_ENABLED=true e forneça a configuração externa documentada.");
    await login(page, account("ATTENDANT"));
    await openModule(page, "Visão geral");
    await expect(page.getByRole("heading", { name: "Unidades vinculadas" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Administração de acesso" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Convidar usuário" })).toHaveCount(0);
  });

  test("atendente altera a própria disponibilidade na unidade selecionada",async({page})=>{
    test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para homologar disponibilidade local.");await login(page,account("ATTENDANT"));
    const mutations:string[]=[];const externalHosts:string[]=[];page.on("request",request=>{const url=new URL(request.url());
      if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);
      if(url.pathname.startsWith("/v1/")&&["POST","PATCH","PUT","DELETE"].includes(request.method()))mutations.push(`${request.method()} ${url.pathname}`)});
    await page.reload();await expect(page.getByRole("heading",{name:"Minha disponibilidade"})).toBeVisible();
    await expect(page.getByText(/Status:\s*Disponível/u)).toBeVisible();await page.getByRole("button",{name:"Alterar disponibilidade"}).click();
    await page.getByLabel("Status da disponibilidade").selectOption("PAUSED");await page.getByLabel("Motivo da pausa").selectOption("BREAK");
    await page.getByLabel("Máximo de atendimentos ativos").fill("7");const changed=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname==="/v1/inbox/availability");
    await page.getByRole("button",{name:"Confirmar alteração"}).evaluate((element:HTMLButtonElement)=>{element.click();element.click()});expect((await changed).status()).toBe(200);
    await expect(page.getByText("Disponibilidade atualizada.")).toBeVisible();await expect(page.getByText(/Status:\s*Pausado/u)).toBeVisible();
    expect(mutations).toEqual(["POST /v1/inbox/availability"]);expect(externalHosts).toEqual([]);
  });

  test("inbound materializado permite claim e devolução segura à fila",async({page})=>{
    test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para homologar a Inbox.");await login(page,account("ATTENDANT"));
    const mutations:string[]=[];const externalHosts:string[]=[];page.on("request",request=>{const url=new URL(request.url());if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);
      if(url.pathname.startsWith("/v1/")&&["POST","PATCH","PUT","DELETE"].includes(request.method()))mutations.push(`${request.method()} ${url.pathname}`)});
    await page.reload();await expect(page.getByRole("heading",{name:"Inbox"})).toBeVisible();
    await page.getByRole("button",{name:"Contato · NORMAL"}).click();await expect(page.getByText("Mensagem inbound sintética da Inbox")).toBeVisible();
    await page.getByRole("button",{name:"Assumir atendimento"}).click();await expect(page.getByRole("button",{name:"Contato · Em atendimento"})).toBeVisible();
    await expect(page.getByText("Estado: HUMAN_ACTIVE")).toBeVisible();expect(mutations.filter(value=>value.endsWith("/claim"))).toHaveLength(1);
    await page.reload();await expect(page.getByRole("button",{name:"Contato · Em atendimento"})).toBeVisible();await page.getByRole("button",{name:"Contato · Em atendimento"}).click();
    await expect(page.getByText("Estado: HUMAN_ACTIVE")).toBeVisible();await expect(page.getByRole("button",{name:"Enviar"})).toBeVisible();
    await page.getByRole("button",{name:"Devolver à fila"}).click();await expect(page.getByText("Atendimento devolvido à fila.")).toBeVisible();await expect(page.getByRole("button",{name:"Contato · NORMAL"})).toBeVisible();
    await page.reload();await expect(page.getByRole("button",{name:"Contato · NORMAL"})).toBeVisible();await expect(page.getByRole("button",{name:"Contato · Em atendimento"})).toHaveCount(0);
    expect(mutations).toEqual([`POST /v1/inbox/handoffs/90000000-0000-4000-8000-000000000060/claim`,`POST /v1/inbox/handoffs/90000000-0000-4000-8000-000000000060/requeue`]);expect(externalHosts).toEqual([]);
  });

  test("resposta humana TEXT fica QUEUED local e persiste sem Meta ou Hermes",async({page})=>{test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para homologar resposta local.");await login(page,account("ATTENDANT"));
    const messagePosts:string[]=[];const mutations:string[]=[];const refreshGets:string[]=[];const externalHosts:string[]=[];let observeRefresh=false;page.on("request",request=>{const url=new URL(request.url());if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);
      if(url.pathname.startsWith("/v1/")&&["POST","PATCH","PUT","DELETE"].includes(request.method()))mutations.push(`${request.method()} ${url.pathname}`);
      if(observeRefresh&&request.method()==="GET"&&url.pathname.startsWith("/v1/inbox/"))refreshGets.push(url.pathname);
      if(request.method()==="POST"&&url.pathname.endsWith("/messages"))messagePosts.push(url.pathname)});await page.reload();await page.getByRole("button",{name:"Contato · NORMAL"}).click();
    await page.getByRole("button",{name:"Assumir atendimento"}).click();const editor=page.getByRole("textbox",{name:"Mensagem"});await expect(editor).toBeVisible();await editor.fill("  draft preservado byte a byte\n");observeRefresh=true;
    const refresh=page.getByRole("button",{name:"Atualizar Inbox"});await refresh.evaluate((element:HTMLButtonElement)=>{element.click();element.click()});await expect(page.getByRole("button",{name:"Atualizando…"})).toBeVisible();await expect(refresh).toBeVisible();observeRefresh=false;
    await expect(editor).toHaveValue("  draft preservado byte a byte\n");expect(refreshGets.filter(path=>path==="/v1/inbox/handoffs")).toHaveLength(1);expect(refreshGets.filter(path=>path==="/v1/inbox/active")).toHaveLength(1);
    expect(refreshGets).toHaveLength(5);expect(refreshGets.filter(path=>path==="/v1/inbox/availability")).toHaveLength(1);expect(refreshGets.filter(path=>/^\/v1\/inbox\/conversations\/[^/]+(?:\/messages)?$/u.test(path))).toHaveLength(2);expect(mutations.filter(value=>!value.endsWith("/claim"))).toEqual([]);
    await editor.fill("Resposta humana sintética");
    await page.getByRole("button",{name:"Enviar"}).click();await expect(page.getByText("Resposta humana sintética")).toBeVisible();await expect(page.getByText("Pendente de envio")).toBeVisible();expect(messagePosts).toHaveLength(1);
    await page.reload();await page.getByRole("button",{name:"Contato · Em atendimento"}).click();await expect(page.getByText("Resposta humana sintética")).toBeVisible();await expect(page.getByText("Pendente de envio")).toBeVisible();
    expect(messagePosts).toHaveLength(1);expect(externalHosts).toEqual([]);await expect(page.getByText("Enviado",{exact:true})).toHaveCount(0);
  });

  test("cancelamento local mantém TEXT na timeline e invalida o outbox ainda virgem",async({page})=>{test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para homologar cancelamento local.");await login(page,account("ATTENDANT"));
    const cancelPosts:string[]=[];const externalHosts:string[]=[];page.on("request",request=>{const url=new URL(request.url());if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);
      if(request.method()==="POST"&&url.pathname.endsWith("/cancel"))cancelPosts.push(url.pathname)});await page.reload();await page.getByRole("button",{name:"Contato · NORMAL"}).click();
    await page.getByRole("button",{name:"Assumir atendimento"}).click();const editor=page.getByRole("textbox",{name:"Mensagem"});await editor.fill("Resposta cancelável sintética");await page.getByRole("button",{name:"Enviar"}).click();
    await expect(page.getByText("Pendente de envio")).toBeVisible();await page.getByRole("button",{name:"Cancelar envio"}).click();await expect(page.getByText("Envio cancelado")).toBeVisible();expect(cancelPosts).toHaveLength(1);
    await page.reload();await page.getByRole("button",{name:"Contato · Em atendimento"}).click();await expect(page.getByText("Resposta cancelável sintética")).toBeVisible();await expect(page.getByText("Envio cancelado")).toBeVisible();
    await expect(page.getByRole("button",{name:"Cancelar envio"})).toHaveCount(0);expect(cancelPosts).toHaveLength(1);expect(externalHosts).toEqual([]);await expect(page.getByText("Enviado",{exact:true})).toHaveCount(0);
  });

  test("atendente encerra o próprio atendimento ativo sem outbound ou Hermes",async({page})=>{test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para homologar encerramento local.");await login(page,account("ATTENDANT"));
    const mutations:string[]=[];const externalHosts:string[]=[];page.on("request",request=>{const url=new URL(request.url());if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);
      if(url.pathname.startsWith("/v1/")&&["POST","PATCH","PUT","DELETE"].includes(request.method()))mutations.push(`${request.method()} ${url.pathname}`)});
    await page.reload();await page.getByRole("button",{name:"Contato · NORMAL"}).click();await page.getByRole("button",{name:"Assumir atendimento"}).click();
    await expect(page.getByText("Estado: HUMAN_ACTIVE")).toBeVisible();const resolved=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname.endsWith("/resolve"));
    await page.getByRole("button",{name:"Encerrar atendimento"}).click();await page.getByLabel("Disposição do encerramento").selectOption("RESOLVED");
    await page.getByRole("button",{name:"Confirmar encerramento"}).click();expect((await resolved).status()).toBe(200);await expect(page.getByText("Atendimento encerrado.")).toBeVisible();
    await expect(page.getByRole("button",{name:"Contato · Em atendimento"})).toHaveCount(0);await page.reload();await expect(page.getByRole("button",{name:"Contato · Em atendimento"})).toHaveCount(0);
    await expect(page.getByRole("textbox",{name:"Mensagem"})).toHaveCount(0);await expect(page.getByRole("button",{name:/Enviar|Responder/})).toHaveCount(0);
    expect(mutations).toEqual([`POST /v1/inbox/handoffs/90000000-0000-4000-8000-000000000060/claim`,`POST /v1/inbox/handoffs/90000000-0000-4000-8000-000000000060/resolve`]);expect(externalHosts).toEqual([]);
  });

  test("gestor consulta atendimento encerrado em modo somente leitura",async({page})=>{test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para homologar histórico local.");await login(page,account("MANAGER"));
    const mutations:string[]=[];const externalHosts:string[]=[];const historyGets:string[]=[];page.on("request",request=>{const url=new URL(request.url());if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);
      if(url.pathname.startsWith("/v1/")&&["POST","PATCH","PUT","DELETE"].includes(request.method()))mutations.push(`${request.method()} ${url.pathname}`);
      if(request.method()==="GET"&&url.pathname.startsWith("/v1/inbox/"))historyGets.push(`${url.pathname}${url.search}`)});
    await page.reload();await expect(page.getByRole("heading",{name:"Encerrados"})).toBeVisible();
    const priority=page.getByLabel("Prioridade dos encerrados");const disposition=page.getByLabel("Disposição dos encerrados");
    const resolvedFrom=page.getByLabel("Encerrados a partir de");const resolvedBefore=page.getByLabel("Encerrados antes de");
    await priority.selectOption("NORMAL");await expect(page.getByText("Há alterações de filtro ainda não aplicadas.")).toBeVisible();
    const getsBeforeInvalid=historyGets.filter(value=>value.startsWith("/v1/inbox/resolved?")).length;
    await resolvedFrom.evaluate((element:HTMLInputElement)=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;if(!setter)throw new Error("NATIVE_INPUT_VALUE_SETTER_MISSING");setter.call(element,"2025-01-01T00:00:00.000");element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}))});
    await resolvedBefore.evaluate((element:HTMLInputElement)=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;if(!setter)throw new Error("NATIVE_INPUT_VALUE_SETTER_MISSING");setter.call(element,"2026-01-02T00:00:00.001");element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}))});
    await page.getByRole("button",{name:"Aplicar filtros dos encerrados"}).click();await expect(page.getByRole("alert")).toContainText("O período dos atendimentos encerrados deve ter no máximo 366 dias.");
    expect(historyGets.filter(value=>value.startsWith("/v1/inbox/resolved?")).length).toBe(getsBeforeInvalid);expect(mutations).toEqual([]);
    const cleared=page.waitForResponse(response=>response.request().method()==="GET"&&new URL(response.url()).pathname==="/v1/inbox/resolved"&&new URL(response.url()).searchParams.size===2);
    await page.getByRole("button",{name:"Limpar filtros dos encerrados"}).click();expect((await cleared).status()).toBe(200);
    await expect(priority).toHaveValue("");await expect(disposition).toHaveValue("");await expect(resolvedFrom).toHaveValue("");await expect(resolvedBefore).toHaveValue("");
    await expect(page.getByText("Há alterações de filtro ainda não aplicadas.")).toHaveCount(0);
    await priority.selectOption("NORMAL");await disposition.selectOption("RESOLVED");
    const filtered=page.waitForResponse(response=>response.request().method()==="GET"&&new URL(response.url()).pathname==="/v1/inbox/resolved"&&new URL(response.url()).searchParams.get("priority")==="NORMAL"&&new URL(response.url()).searchParams.get("disposition")==="RESOLVED");
    await page.getByRole("button",{name:"Aplicar filtros dos encerrados"}).click();expect((await filtered).status()).toBe(200);
    const historicalItem=page.getByRole("button",{name:"Contato · Encerrado"});await expect(historicalItem).toContainText("Resolvido · LOCAL_E2E");await historicalItem.click();await expect(historicalItem).toHaveAttribute("aria-pressed","true");
    await expect(page.getByText("Mensagem inbound sintética da Inbox")).toBeVisible();await expect(page.getByText("Estado: SUSPENDED")).toBeVisible();
    await expect(page.getByRole("textbox",{name:"Mensagem"})).toHaveCount(0);await expect(page.getByRole("button",{name:/Assumir|Enviar|Encerrar|Devolver|Transferir|Cancelar envio/})).toHaveCount(0);
    expect(historyGets.some(value=>value.startsWith("/v1/inbox/resolved?"))).toBe(true);expect(historyGets.some(value=>value.includes("/messages?")&&value.includes("before="))).toBe(true);
    expect(mutations).toEqual([]);expect(externalHosts).toEqual([]);
  });

  test("gestor reabre atendimento encerrado uma única vez, após reload mantém a fonte inelegível e rejeita replay divergente",async({page})=>{test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para homologar reabertura local.");await login(page,account("MANAGER"));
    const mutations:string[]=[];const reopenPosts:string[]=[];const externalHosts:string[]=[];page.on("request",request=>{const url=new URL(request.url());if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);
      if(url.pathname.startsWith("/v1/")&&["POST","PATCH","PUT","DELETE"].includes(request.method()))mutations.push(`${request.method()} ${url.pathname}`);
      if(request.method()==="POST"&&url.pathname.endsWith("/reopen"))reopenPosts.push(url.pathname)});
    await page.reload();const historicalItem=page.getByRole("button",{name:"Contato · Encerrado"});await historicalItem.click();await page.getByRole("button",{name:"Reabrir atendimento"}).click();
    await expect(page.getByText("O atendimento voltará à fila humana. A automação não será reativada.")).toBeVisible();const confirm=page.getByRole("button",{name:"Confirmar reabertura"});await expect(confirm).toBeDisabled();
    await page.getByLabel("Motivo da reabertura").selectOption("FOLLOW_UP_REQUIRED");const reopened=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname.endsWith("/reopen"));
    await confirm.evaluate((element:HTMLButtonElement)=>{element.click();element.click()});const reopenedResponse=await reopened;expect(reopenedResponse.status()).toBe(200);await expect(page.getByText("Atendimento reaberto na fila humana.")).toBeVisible();
    await expect(page.getByRole("button",{name:"Contato · NORMAL"})).toBeVisible();await expect(page.getByRole("button",{name:"Contato · Encerrado"})).toBeVisible();await expect(page.getByRole("button",{name:"Reabrir atendimento"})).toHaveCount(0);
    expect(reopenPosts).toHaveLength(1);expect(mutations).toEqual([`POST ${reopenPosts[0]}`]);
    await page.reload();await expect(page.getByRole("heading",{name:"Encerrados"})).toBeVisible();const preservedSource=page.getByRole("button",{name:"Contato · Encerrado"});await expect(preservedSource).toBeVisible();await preservedSource.click();await expect(page.getByRole("button",{name:"Reabrir atendimento"})).toHaveCount(0);
    const originalRequest=reopenedResponse.request();const originalHeaders=await originalRequest.allHeaders();const authorization=originalHeaders.authorization;const idempotencyKey=originalHeaders["idempotency-key"];const originalBody=originalRequest.postDataJSON() as {expectedVersion?:unknown;reason?:unknown};
    if(!authorization||!idempotencyKey||typeof originalBody.expectedVersion!=="number"||originalBody.reason!=="FOLLOW_UP_REQUIRED")throw new Error("REOPEN_REPLAY_CAPTURE_INVALID");
    const divergentReplay=await page.evaluate(async({url,authorization,idempotencyKey,expectedVersion})=>{const response=await fetch(url,{method:"POST",headers:{authorization,"idempotency-key":idempotencyKey,"content-type":"application/json"},body:JSON.stringify({expectedVersion,reason:"PREMATURE_CLOSURE"})});return{status:response.status,body:await response.json() as {status?:unknown}}},{url:originalRequest.url(),authorization,idempotencyKey,expectedVersion:originalBody.expectedVersion});expect(divergentReplay.status).toBe(409);expect(divergentReplay.body.status).toBe(409);expect(externalHosts).toEqual([]);
  });

  test("transfere atendimento entre dois atendentes da mesma unidade",async({browser})=>{test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para homologar transferência local.");
    const ownerContext=await browser.newContext();const targetContext=await browser.newContext();const ownerPage=await ownerContext.newPage();const targetPage=await targetContext.newPage();
    const externalHosts:string[]=[];const transferPosts:string[]=[];for(const page of[ownerPage,targetPage])page.on("request",request=>{const url=new URL(request.url());if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);if(request.method()==="POST"&&url.pathname.endsWith("/transfer"))transferPosts.push(url.pathname)});
    try{await login(ownerPage,account("ATTENDANT"));await login(targetPage,account("ATTENDANT_TWO"));await ownerPage.getByRole("button",{name:"Contato · NORMAL"}).click();await ownerPage.getByRole("button",{name:"Assumir atendimento"}).click();
      await ownerPage.getByRole("button",{name:"Transferir atendimento"}).click();await ownerPage.getByLabel("Atendente de destino").selectOption({label:"Atendente Local 2"});
      await ownerPage.getByLabel("Motivo da transferência").selectOption("SHIFT_CHANGE");const transferred=ownerPage.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname.endsWith("/transfer"));
      await ownerPage.getByRole("button",{name:"Confirmar transferência"}).click();expect((await transferred).status()).toBe(200);await expect(ownerPage.getByText("Atendimento transferido.")).toBeVisible();expect(transferPosts).toHaveLength(1);
      await expect(ownerPage.getByRole("button",{name:"Contato · Em atendimento"})).toHaveCount(0);const activeRead=targetPage.waitForResponse(response=>new URL(response.url()).pathname==="/v1/inbox/active",{timeout:15_000});const supervisedRead=targetPage.waitForResponse(response=>new URL(response.url()).pathname==="/v1/inbox/supervised",{timeout:15_000});await targetPage.reload();const[activeResponse,supervisedResponse]=await Promise.all([activeRead,supervisedRead]);if(activeResponse.status()!==200||supervisedResponse.status()!==200)throw new Error(`TRANSFER_TARGET_LIST_FAILURE:${activeResponse.status()}:${supervisedResponse.status()}`);const targetActive=targetPage.getByRole("button",{name:"Contato · Em atendimento"});if(!await targetActive.isVisible({timeout:15_000}))throw new Error(`TRANSFER_TARGET_ACTIVE_NOT_VISIBLE:${(await activeResponse.text()).slice(0,1000)}:${(await targetPage.locator("body").innerText()).slice(0,1500)}`);await targetActive.click();await expect(targetPage.getByText("Estado: HUMAN_ACTIVE")).toBeVisible();
      expect(externalHosts).toEqual([]);await expect(targetPage.getByText("Enviado",{exact:true})).toHaveCount(0);
    }finally{await targetContext.close();await ownerContext.close();}
  });

  test("gestor transfere e reconcilia supervisão",async({page})=>{test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para homologar a reconciliação supervisionada após transferência.");
    await login(page,account("MANAGER"));
    const externalHosts:string[]=[];const metaRequests:string[]=[];const transferPosts:string[]=[];
    page.on("request",request=>{const url=new URL(request.url());
      if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);
      if(request.method()==="POST"&&url.pathname.endsWith("/transfer"))transferPosts.push(url.pathname);
      if(url.pathname==="/v1/webhooks/meta"||url.hostname.includes("facebook")||url.hostname.includes("meta"))metaRequests.push(`${request.method()} ${url.href}`)});
    await page.reload();await page.getByRole("button",{name:"Contato · NORMAL"}).click();await page.getByRole("button",{name:"Assumir atendimento"}).click();
    await expect(page.getByRole("button",{name:"Contato · Em atendimento"})).toBeVisible();await page.getByRole("button",{name:"Transferir atendimento"}).click();
    await page.getByLabel("Atendente de destino").selectOption({label:"Atendente Local"});await page.getByLabel("Motivo da transferência").selectOption("LOAD_BALANCING");
    const transferred=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname.endsWith("/transfer"));
    await page.getByRole("button",{name:"Confirmar transferência"}).evaluate((element:HTMLButtonElement)=>{element.click();element.click()});
    expect((await transferred).status()).toBe(200);await expect(page.getByText("Atendimento transferido.")).toBeVisible();expect(transferPosts).toHaveLength(1);
    await expect(page.getByRole("button",{name:"Contato · Em atendimento"})).toHaveCount(0);await expect(page.getByRole("button",{name:"Contato · Sob supervisão"})).toBeVisible();
    expect(metaRequests).toEqual([]);expect(externalHosts).toEqual([]);await expect(page.getByText("Enviado",{exact:true})).toHaveCount(0);
  });

  test("gestor assume atendimento supervisionado",async({browser})=>{test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para homologar takeover local.");
    const ownerContext=await browser.newContext();const managerContext=await browser.newContext();const ownerPage=await ownerContext.newPage();const managerPage=await managerContext.newPage();
    const externalHosts:string[]=[];const mutations:string[]=[];const takeoverPosts:string[]=[];for(const page of[ownerPage,managerPage])page.on("request",request=>{const url=new URL(request.url());
      if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);
      if(url.pathname.startsWith("/v1/")&&["POST","PATCH","PUT","DELETE"].includes(request.method()))mutations.push(`${request.method()} ${url.pathname}`);
      if(request.method()==="POST"&&url.pathname.endsWith("/takeover"))takeoverPosts.push(url.pathname)});
    try{await login(ownerPage,account("ATTENDANT"));await login(managerPage,account("MANAGER"));
      await ownerPage.getByRole("button",{name:"Contato · NORMAL"}).click();await ownerPage.getByRole("button",{name:"Assumir atendimento"}).click();
      await expect(ownerPage.getByRole("button",{name:"Contato · Em atendimento"})).toBeVisible();
      await managerPage.reload();const supervised=managerPage.getByRole("button",{name:"Contato · Sob supervisão"});await expect(supervised).toBeVisible();await supervised.click();
      await expect(managerPage.getByText("Estado: HUMAN_ACTIVE")).toBeVisible();await managerPage.getByRole("button",{name:"Assumir como supervisor"}).click();
      const takeover=managerPage.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname.endsWith("/takeover"));
      await managerPage.getByRole("button",{name:"Confirmar assunção"}).evaluate((element:HTMLButtonElement)=>{element.click();element.click()});expect((await takeover).status()).toBe(200);
      await expect(managerPage.getByText("Atendimento assumido pela supervisão.")).toBeVisible();expect(takeoverPosts).toHaveLength(1);
      await expect(managerPage.getByRole("button",{name:"Contato · Em atendimento"})).toBeVisible();await expect(managerPage.getByRole("button",{name:"Contato · Sob supervisão"})).toHaveCount(0);
      await ownerPage.reload();await expect(ownerPage.getByRole("button",{name:"Contato · Em atendimento"})).toHaveCount(0);
      expect(mutations).toEqual([`POST /v1/inbox/handoffs/90000000-0000-4000-8000-000000000060/claim`,`POST /v1/inbox/handoffs/90000000-0000-4000-8000-000000000060/takeover`]);expect(externalHosts).toEqual([]);
      await expect(managerPage.getByText("Enviado",{exact:true})).toHaveCount(0);
    }finally{await managerContext.close();await ownerContext.close();}
  });

  test("reconciliação sintética local aplica statuses assinados sem envio Meta",async({page})=>{test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para a reconciliação sintética local.");
    const externalHosts:string[]=[];const statusPosts:string[]=[];page.on("request",request=>{const url=new URL(request.url());if(url.hostname!=="zap-pronto.127.0.0.1.nip.io")externalHosts.push(url.host);
      if(request.method()==="POST"&&url.pathname==="/v1/webhooks/meta")statusPosts.push(url.pathname)});await login(page,account("ATTENDANT"));
    const callbacks=[
      {status:"delivered",timestamp:"1786382700"},{status:"read",timestamp:"1786382760"},
      {status:"read",timestamp:"1786382760"},{status:"sent",timestamp:"1786382640"},
    ];
    for(const item of callbacks){const body=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:"local-e2e-account"},statuses:[{
        id:"wamid.local.synthetic.status.001",recipient_id:"synthetic-customer",status:item.status,timestamp:item.timestamp}]}}]}]});
      const signature=`sha256=${createHmac("sha256","local-e2e-public-hmac-vector-v1").update(body).digest("hex")}`;
      const result=await page.evaluate(async input=>{const response=await fetch("/v1/webhooks/meta",{method:"POST",headers:{"content-type":"application/json","x-hub-signature-256":input.signature},body:input.body});return{status:response.status,text:await response.text()}},{body,signature});
      expect(result).toEqual({status:200,text:"OK"});}
    await page.reload();await page.getByRole("button",{name:"Contato · NORMAL"}).click();
    await expect(page.getByText("Mensagem outbound sintética seedada como SENT")).toBeVisible();
    await expect(page.getByText("Lido",{exact:true})).toBeVisible();expect(statusPosts).toHaveLength(4);expect(externalHosts).toEqual([]);
    for(const regressive of["Pendente de envio","Enviado","Entregue"])await expect(page.getByText(regressive,{exact:true})).toHaveCount(0);
  });

  test("administrador revoga e reativa vínculo unitário com efeito imediato",async({page})=>{test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true para o lifecycle de membership local.");const identifier=process.env.E2E_ATTENDANT_TWO_ADMIN_LIST_MATCH;if(!identifier)throw new Error("E2E_ATTENDANT_TWO_ADMIN_LIST_MATCH_REQUIRED");await login(page,account("ADMIN"));await openModule(page,"Acessos");
    const openMembership=async()=>{const row=await userRow(page,identifier);return row.getByRole("list",{name:"Vínculos de Atendente Local 2"})};
    try{const membership=await openMembership();await membership.getByRole("button",{name:"Revogar vínculo"}).click();await page.getByLabel("Motivo").fill("Homologação lifecycle unitário");const post=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith("/lifecycle")&&response.request().method()==="POST");await page.getByRole("button",{name:"Confirmar revogar vínculo"}).click();expect((await post).status()).toBe(200);await expect((await openMembership()).getByText(/Revogado/)).toBeVisible();await expect((await openMembership()).getByRole("button",{name:"Reativar vínculo"})).toBeVisible();
    }finally{await page.goto("/");await openModule(page,"Acessos");const membership=await openMembership();const reactivate=membership.getByRole("button",{name:"Reativar vínculo"});if(await reactivate.count()){await reactivate.click();await page.getByLabel("Motivo").fill("Limpeza lifecycle unitário");const post=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith("/lifecycle")&&response.request().method()==="POST");await page.getByRole("button",{name:"Confirmar reativar vínculo"}).click();expect((await post).status()).toBe(200)}await expect((await openMembership()).getByText(/Ativo/)).toBeVisible()}
  });

  test("gestor administra vínculos da unidade",async({page})=>{
    test.skip(!enabled,"Defina E2E_OIDC_ENABLED=true e E2E_MANAGER_* para homologar o gestor unitário local.");
    const catalogGets:string[]=[];const tenantWideRequests:string[]=[];const lifecyclePosts:{path:string;operation:unknown}[]=[];
    page.on("request",request=>{const url=new URL(request.url());if(request.method()==="GET"&&(url.pathname==="/v1/users"||url.pathname.startsWith("/v1/users/invitations")))tenantWideRequests.push(`${request.method()} ${url.pathname}`);
      if(request.method()==="GET"&&/^\/v1\/units\/[^/]+\/memberships$/u.test(url.pathname))catalogGets.push(url.pathname);
      if(request.method()==="POST"&&/^\/v1\/users\/[^/]+\/memberships\/[^/]+\/lifecycle$/u.test(url.pathname)){let operation:unknown;try{operation=(request.postDataJSON()as{operation?:unknown}).operation}catch{operation=undefined}lifecyclePosts.push({path:url.pathname,operation})}});
    await login(page,account("MANAGER"));
    await openModule(page,"Vínculos");
    const heading=page.getByRole("heading",{name:"Vínculos da unidade"});await expect(heading).toBeVisible();
    await expect(page.getByRole("heading",{name:"Administração de acesso"})).toHaveCount(0);
    await expect(page.getByRole("heading",{name:"Convidar usuário"})).toHaveCount(0);
    const panel=heading.locator("xpath=ancestor::section[1]");await expect(panel.getByText(/@/u)).toHaveCount(0);
    const list=heading.locator("xpath=following-sibling::ul[1]");
    const target=list.getByRole("listitem").filter({hasText:"Atendente Local"}).filter({hasNotText:"Atendente Local 2"});
    await expect(target).toHaveCount(1);await expect(target).toContainText("Ativo");
    let revoked=false;
    try{
      await target.getByRole("button",{name:"Revogar vínculo"}).click();await page.getByLabel("Motivo").fill("Homologação OIDC do gestor unitário");
      const revoke=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname.endsWith("/lifecycle"));
      await page.getByRole("button",{name:"Confirmar revogar vínculo"}).click();expect((await revoke).status()).toBe(200);revoked=true;
      await expect(target).toContainText("Revogado");await expect(target.getByRole("button",{name:"Reativar vínculo"})).toBeVisible();
    }finally{
      if(revoked){const reactivateButton=target.getByRole("button",{name:"Reativar vínculo"});await expect(reactivateButton).toBeVisible();await reactivateButton.click();
        await page.getByLabel("Motivo").fill("Limpeza da homologação OIDC do gestor unitário");const reactivate=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname.endsWith("/lifecycle"));
        await page.getByRole("button",{name:"Confirmar reativar vínculo"}).click();expect((await reactivate).status()).toBe(200);await expect(target).toContainText("Ativo")}
    }
    expect(catalogGets).toHaveLength(3);expect(new Set(catalogGets).size).toBe(1);expect(tenantWideRequests).toEqual([]);
    expect(lifecyclePosts.filter(request=>request.operation==="REVOKE")).toHaveLength(1);expect(lifecyclePosts.filter(request=>request.operation==="REACTIVATE")).toHaveLength(1);
    expect(lifecyclePosts[0]?.path).toBe(lifecyclePosts[1]?.path);
  });

  test("renovação mantém /v1/me somente quando configurada externamente", async ({ page }) => {
    test.skip(!enabled, "Defina E2E_OIDC_ENABLED=true para homologar renovação.");
    const rawWait = process.env.E2E_RENEW_WAIT_SECONDS;
    const waitSeconds = rawWait && /^\d+$/.test(rawWait) ? Number(rawWait) : 0;
    if (!Number.isSafeInteger(waitSeconds) || waitSeconds <= 0) {
      if (requireRenewal) throw new Error("E2E_RENEW_WAIT_SECONDS_VALID_POSITIVE_INTEGER_REQUIRED");
      test.skip(true, "Defina E2E_RENEW_WAIT_SECONDS conforme o TTL real do provedor.");
    }
    test.slow();
    const configuration = account("ATTENDANT");
    await login(page, configuration);
    const originalExpiration = await oidcAccessTokenExpiration(page);
    await page.waitForTimeout(waitSeconds * 1000);
    expect(Math.floor(Date.now() / 1000), "A espera configurada precisa cruzar a expiração do token original")
      .toBeGreaterThanOrEqual(originalExpiration);
    const me = page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/me"
      && response.status() === 200);
    await page.reload();
    await me;
    const renewedExpiration = await oidcAccessTokenExpiration(page);
    expect(renewedExpiration, "O provedor deve substituir o token expirado por outro com validade posterior")
      .toBeGreaterThan(originalExpiration);
    await expect(page.getByRole("heading", { name: configuration.tenant })).toBeVisible();
  });

  test("bloqueio invalida sessão emitida e reativação limpa a homologação", async ({ browser }) => {
    test.skip(!enabled || !requireBlockRevocation,
      "Defina E2E_REQUIRE_BLOCK_REVOCATION=true para autorizar a mutação reversível da conta de teste.");
    const admin = account("ADMIN");
    const attendant = account("ATTENDANT");
    const attendantListMatch = optional("E2E_ATTENDANT_ADMIN_LIST_MATCH") ?? attendant.username;
    const adminContext = await browser.newContext();
    const attendantContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const attendantPage = await attendantContext.newPage();
    let adminAuthenticated = false;
    try {
      await login(adminPage, admin); adminAuthenticated = true; await openModule(adminPage, "Acessos");
      await login(attendantPage, attendant);
      const row = await userRow(adminPage, attendantListMatch);
      await row.getByRole("button", { name: "Bloquear" }).click();
      await adminPage.getByLabel("Motivo").fill("Homologação obrigatória de revogação de sessão");
      await adminPage.getByRole("button", { name: "Confirmar bloquear" }).click();
      await expect((await userRow(adminPage, attendantListMatch)).getByRole("button", { name: "Reativar" })).toBeVisible();

      const denied = attendantPage.waitForResponse((response) => new URL(response.url()).pathname === "/v1/me"
        && response.request().method() === "GET" && response.status() === 401);
      await attendantPage.reload();
      await denied;
      await expect(attendantPage.getByRole("button", { name: "Entrar" })).toBeVisible();
      await expect(attendantPage.getByRole("heading", { name: attendant.tenant })).toHaveCount(0);
    } finally {
      try {
        if (adminAuthenticated) await reactivateAttendant(adminPage, attendantListMatch);
      } finally {
        await attendantContext.close();
        await adminContext.close();
      }
    }
  });
});
