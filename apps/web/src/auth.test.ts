// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createUserManager: vi.fn(),
  signinCallback: vi.fn(),
  signinSilent: vi.fn(),
  removeUser: vi.fn(),
  clearStaleState: vi.fn(),
  getUser: vi.fn(),
  stores: [] as unknown[],
}));
vi.mock("oidc-client-ts", () => ({
  UserManager: vi.fn(function UserManagerMock(options: unknown) { return mocks.createUserManager(options); }),
  InMemoryWebStorage: vi.fn(function InMemoryWebStorageMock() { return {}; }),
  WebStorageStateStore: vi.fn(function WebStorageStateStoreMock(options: unknown) { mocks.stores.push(options); return {}; }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.stores.length = 0;
  vi.stubEnv("VITE_OIDC_AUTHORITY", "https://identity.example.test");
  vi.stubEnv("VITE_OIDC_CLIENT_ID", "web-client");
  vi.stubEnv("VITE_OIDC_AUDIENCE", "");
  mocks.createUserManager.mockReturnValue(mocks);
  window.history.replaceState({}, "", "/callback");
  window.sessionStorage.clear();
  delete window.__ZAP_PRONTO_AUTH__;
});

describe("OIDC bootstrap", () => {
  it("requests the API audience while preserving code flow", async () => {
    vi.stubEnv("VITE_OIDC_AUDIENCE", " https://api.example.test ");
    const { initializeAuth } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "ready" });
    expect(mocks.createUserManager).toHaveBeenCalledWith(expect.objectContaining({
      extraQueryParams: { audience: "https://api.example.test" },
      response_type: "code", scope: "openid profile email",
      redirect_uri: "http://localhost:3000",
      silent_redirect_uri: "http://localhost:3000",
      maxSilentRenewTimeoutRetries: 0,
    }));
  });

  it.each(["", "   "])("omits optional audience when blank (%j)", async (value) => {
    vi.stubEnv("VITE_OIDC_AUDIENCE", value);
    const { initializeAuth } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "ready" });
    expect(mocks.createUserManager.mock.calls[0]?.[0]).not.toHaveProperty("extraQueryParams");
  });

  it("removes the complete callback query and fragment before returning a sanitized error", async () => {
    window.history.replaceState({}, "", "/callback?error=access_denied&error_description=secret&vendor=value#access_token=token");
    mocks.signinCallback.mockRejectedValueOnce(new Error("invalid state"));
    const { initializeAuth } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "error" });
    expect(window.location.href).toBe("http://localhost:3000/callback");
    expect(window.__ZAP_PRONTO_AUTH__).toBeUndefined();
    expect(mocks.signinCallback).toHaveBeenCalledWith(
      "http://localhost:3000/callback?error=access_denied&error_description=secret&vendor=value#access_token=token",
    );
  });

  it("coalesces concurrent retries into one reset and initialization", async () => {
    const { initializeAuth, retryAuthInitialization } = await import("./auth.js");
    await initializeAuth();
    await Promise.all([retryAuthInitialization(), retryAuthInitialization()]);
    expect(mocks.removeUser).toHaveBeenCalledTimes(1);
    expect(mocks.clearStaleState).toHaveBeenCalledTimes(1);
  });

  it("delivers the original callback to the SDK after removing it from the browser URL", async () => {
    window.history.replaceState({}, "", "/callback?code=ok&state=state-1#unexpected");
    mocks.signinCallback.mockResolvedValueOnce({ access_token: "memory-only" });
    const { initializeAuth, isAuthConfigured } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "ready" });
    expect(window.location.href).toBe("http://localhost:3000/callback");
    expect(mocks.signinCallback).toHaveBeenCalledWith(
      "http://localhost:3000/callback?code=ok&state=state-1#unexpected",
    );
    expect(isAuthConfigured()).toBe(true);
    expect(window.__ZAP_PRONTO_AUTH__).toBeDefined();
    expect(window.sessionStorage.getItem("zap-pronto.auth.session")).toBe("1");
  });

  it("does not mount the application inside a silent callback iframe", async () => {
    window.history.replaceState({}, "", "/callback?code=ok&state=silent-state");
    mocks.signinCallback.mockResolvedValueOnce(undefined);
    const { initializeAuth } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "redirecting" });
    expect(window.__ZAP_PRONTO_AUTH__).toBeUndefined();
    expect(window.sessionStorage.getItem("zap-pronto.auth.session")).toBeNull();
  });

  it("does not attempt silent restoration without a session marker", async () => {
    const { initializeAuth } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "ready" });
    expect(mocks.signinSilent).not.toHaveBeenCalled();
  });

  it("restores a marked session silently without persisting the user or token", async () => {
    window.sessionStorage.setItem("zap-pronto.auth.session", "1");
    mocks.getUser.mockResolvedValueOnce(undefined);
    mocks.signinSilent.mockResolvedValueOnce({ access_token: "memory-only" });
    const { initializeAuth } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "ready" });
    expect(mocks.signinSilent).toHaveBeenCalledWith({ forceIframeAuth: true });
    expect(Object.keys(window.sessionStorage)).toEqual(["zap-pronto.auth.session"]);
  });

  it("clears a stale marker when the provider no longer has a session", async () => {
    window.sessionStorage.setItem("zap-pronto.auth.session", "1");
    mocks.getUser.mockResolvedValueOnce(undefined);
    mocks.signinSilent.mockRejectedValueOnce(new Error("login_required"));
    const { initializeAuth } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "ready" });
    expect(window.sessionStorage.getItem("zap-pronto.auth.session")).toBeNull();
    expect(mocks.removeUser).toHaveBeenCalledTimes(1);
  });

  it("stays logged out when cleanup also fails after silent restoration", async () => {
    window.sessionStorage.setItem("zap-pronto.auth.session", "1");
    mocks.getUser.mockResolvedValueOnce(undefined);
    mocks.signinSilent.mockRejectedValueOnce(new Error("network_error"));
    mocks.removeUser.mockRejectedValueOnce(new Error("storage_error"));
    const { initializeAuth } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "ready" });
    expect(window.sessionStorage.getItem("zap-pronto.auth.session")).toBeNull();
  });

  it("clears the non-sensitive marker when the local session is cleared", async () => {
    window.sessionStorage.setItem("zap-pronto.auth.session", "1");
    const { initializeAuth, clearAuthSession } = await import("./auth.js");
    await initializeAuth();
    await clearAuthSession();
    expect(window.sessionStorage.getItem("zap-pronto.auth.session")).toBeNull();
  });

  it("keeps user tokens in memory and persists only redirect state", async () => {
    const { initializeAuth } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "ready" });
    expect(mocks.stores).toHaveLength(2);
    expect(mocks.stores[0]).toEqual(expect.objectContaining({ store: expect.anything() }));
    expect(mocks.stores[1]).toEqual({ store: window.sessionStorage });
  });

  it("returns a sanitized error when the OIDC client cannot be constructed", async () => {
    mocks.createUserManager.mockImplementationOnce(() => { throw new Error("storage unavailable"); });
    const { initializeAuth, isAuthConfigured } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "error" });
    expect(isAuthConfigured()).toBe(false);
    expect(window.__ZAP_PRONTO_AUTH__).toBeUndefined();
  });

  it.each([
    ["ready", true], ["error", true], ["redirecting", false], ["blocked", false],
  ] as const)("mount decision for %s is %s", async (status, expected) => {
    const { shouldMountAfterAuthInitialization } = await import("./auth.js");
    expect(shouldMountAfterAuthInitialization({ status })).toBe(expected);
  });
});
