import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ExternalIdentity, IdentityVerifier } from "./contracts.js";
import { parseBearerAuthorization } from "./bearer.js";
import {
  AuthenticationError,
  IdentityProviderUnavailableError,
  IdentityTokenRejectedError,
} from "./errors.js";
import type { Permission } from "../authorization/permissions.js";
import { isProtectedRouteConfig } from "../http/protected-route.js";

declare module "fastify" {
  interface FastifyRequest {
    externalIdentity?: ExternalIdentity;
  }
  interface FastifyContextConfig {
    public?: boolean;
    permission?: Permission;
    authenticated?: boolean;
    bootstrap?: boolean;
    preProvisioning?: boolean;
    authorizationScope?: "tenant" | "unit";
  }
}

export interface AuthenticationPluginOptions {
  readonly verifier: IdentityVerifier | undefined;
}

export const publicEndpointInventory = Object.freeze([
  "GET /health/live",
  "HEAD /health/live",
  "GET /health/ready",
  "HEAD /health/ready",
] as const);
const publicEndpointAllowlist = new Set<string>(publicEndpointInventory);

export interface RegisteredRoutePolicy {
  readonly method: string; readonly url: string;
  readonly policy: "public" | "bootstrap" | "preProvisioning" | "permission";
  readonly permission?: Permission; readonly scope?: "tenant" | "unit";
}
const registeredPolicies = new WeakMap<FastifyInstance, RegisteredRoutePolicy[]>();
export function getRegisteredRoutePolicies(app: FastifyInstance): readonly RegisteredRoutePolicy[] {
  return registeredPolicies.get(app) ?? [];
}

function routeKeys(method: string | string[], url: string): string[] {
  return (Array.isArray(method) ? method : [method]).map((value) => `${value} ${url}`);
}

function isVersionedApiRequest(request: FastifyRequest): boolean {
  const pathname = request.url.split("?", 1)[0];
  return pathname === "/v1" || pathname?.startsWith("/v1/") === true;
}

export function registerAuthenticationBoundary(
  app: FastifyInstance,
  options: AuthenticationPluginOptions,
): void {
  const inventory: RegisteredRoutePolicy[] = [];
  registeredPolicies.set(app, inventory);
  app.addHook("onRoute", (route) => {
    const isVersioned = route.url === "/v1" || route.url.startsWith("/v1/");
    const publicRoute = route.config?.public === true;
    if (isVersioned && publicRoute && route.config?.permission !== undefined) {
      throw new Error(`ROUTE_AUTHORIZATION_POLICY_AMBIGUOUS:${route.method}:${route.url}`);
    }
    const keys = routeKeys(route.method, route.url);
    if (publicRoute && (keys.length === 0 || !keys.every((key) => publicEndpointAllowlist.has(key)))) {
      throw new Error(`ROUTE_PUBLIC_NOT_ALLOWLISTED:${route.method}:${route.url}`);
    }
    if (isVersioned && !publicRoute &&
      (!route.config || !isProtectedRouteConfig(route.config))) {
      throw new Error(`ROUTE_AUTHORIZATION_POLICY_REQUIRED:${route.method}:${route.url}`);
    }
    if (route.config?.bootstrap === true && route.url !== "/v1/me") {
      throw new Error(`ROUTE_BOOTSTRAP_POLICY_FORBIDDEN:${route.method}:${route.url}`);
    }
    if (route.config?.preProvisioning === true && route.url !== "/v1/auth/invitations/accept") {
      throw new Error(`ROUTE_PREPROVISIONING_POLICY_FORBIDDEN:${route.method}:${route.url}`);
    }
    if (isVersioned) {
      const policy = publicRoute ? "public" : route.config?.bootstrap ? "bootstrap"
        : route.config?.preProvisioning ? "preProvisioning" : "permission";
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        inventory.push({ method, url: route.url, policy,
          ...(route.config?.permission ? { permission: route.config.permission } : {}),
          ...(route.config?.authorizationScope ? { scope: route.config.authorizationScope } : {}) });
      }
    }
  });
  app.addHook("onRequest", async (request) => {
    if (!isVersionedApiRequest(request)) return;
    if (request.routeOptions.config.public === true) return;
    const token = parseBearerAuthorization(request.headers.authorization);
    if (!options.verifier) throw new IdentityProviderUnavailableError();
    try {
      request.externalIdentity = await options.verifier.verifyBearer(token);
    } catch (error) {
      if (error instanceof IdentityTokenRejectedError || error instanceof AuthenticationError) {
        throw AuthenticationError.rejected();
      }
      throw new IdentityProviderUnavailableError();
    }
  });
}
