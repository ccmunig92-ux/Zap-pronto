// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createUserManager: vi.fn(),
  signinRedirectCallback: vi.fn(),
  removeUser: vi.fn(),
  clearStaleState: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("oidc-client-ts", () => ({
  UserManager: vi.fn(function UserManagerMock() { return mocks.createUserManager(); }),
  WebStorageStateStore: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("VITE_OIDC_AUTHORITY", "https://identity.example.test");
  vi.stubEnv("VITE_OIDC_CLIENT_ID", "web-client");
  mocks.createUserManager.mockReturnValue(mocks);
  window.history.replaceState({}, "", "/callback");
  delete window.__ZAP_PRONTO_AUTH__;
});

describe("OIDC bootstrap", () => {
  it("removes the complete callback query and fragment before returning a sanitized error", async () => {
    window.history.replaceState({}, "", "/callback?error=access_denied&error_description=secret&vendor=value#access_token=token");
    mocks.signinRedirectCallback.mockRejectedValueOnce(new Error("invalid state"));
    const { initializeAuth } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "error" });
    expect(window.location.href).toBe("http://localhost:3000/callback");
    expect(window.__ZAP_PRONTO_AUTH__).toBeUndefined();
    expect(mocks.signinRedirectCallback).toHaveBeenCalledWith(
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
    mocks.signinRedirectCallback.mockResolvedValueOnce(undefined);
    const { initializeAuth, isAuthConfigured } = await import("./auth.js");
    await expect(initializeAuth()).resolves.toEqual({ status: "ready" });
    expect(window.location.href).toBe("http://localhost:3000/callback");
    expect(mocks.signinRedirectCallback).toHaveBeenCalledWith(
      "http://localhost:3000/callback?code=ok&state=state-1#unexpected",
    );
    expect(isAuthConfigured()).toBe(true);
    expect(window.__ZAP_PRONTO_AUTH__).toBeDefined();
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
