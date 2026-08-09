import { expect, test, type Page } from "@playwright/test";

const enabled = process.env.E2E_OIDC_ENABLED === "true";
const requireRenewal = process.env.E2E_REQUIRE_RENEWAL === "true";
const requireBlockRevocation = process.env.E2E_REQUIRE_BLOCK_REVOCATION === "true";
const optional = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const testTimeoutMs = Number(optional("E2E_OIDC_TEST_TIMEOUT_MS") ?? 90_000);
const usernameSelector = optional("E2E_OIDC_USERNAME_SELECTOR") ?? 'input[name="username"]';
const passwordSelector = optional("E2E_OIDC_PASSWORD_SELECTOR") ?? 'input[name="password"]';
const submitSelector = optional("E2E_OIDC_SUBMIT_SELECTOR") ?? 'button[type="submit"]';

if (enabled) {
  const baseUrl = optional("E2E_BASE_URL");
  let parsed: URL;
  try { parsed = new URL(baseUrl ?? ""); } catch { throw new Error("E2E_BASE_URL_VALID_HTTPS_REQUIRED"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("E2E_BASE_URL_VALID_HTTPS_REQUIRED");
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
function account(prefix: "ADMIN" | "ATTENDANT"): AccountConfiguration {
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
  const list = page.getByRole("heading", { name: "Usuários" }).locator("xpath=following-sibling::ul[1]");
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
    await expect(page.getByRole("heading", { name: "Administração de acesso" })).toBeVisible();
    await page.getByRole("button", { name: "Sair" }).click();
    await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
    const oidcUserKeys = await page.evaluate(() => Object.keys(sessionStorage)
      .filter((key) => key.startsWith("oidc.user:"))).catch(() => [] as string[]);
    expect(oidcUserKeys).toHaveLength(0);
  });

  test("atendente autentica e não recebe controles administrativos", async ({ page }) => {
    test.skip(!enabled, "Defina E2E_OIDC_ENABLED=true e forneça a configuração externa documentada.");
    await login(page, account("ATTENDANT"));
    await expect(page.getByRole("heading", { name: "Unidades vinculadas" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Administração de acesso" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Convidar usuário" })).toHaveCount(0);
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
      await login(adminPage, admin); adminAuthenticated = true;
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
