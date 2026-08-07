import { loadOidcRuntimeConfig, probeOidcReadiness } from "../apps/api/dist/auth/oidc-readiness.js";

try {
  const config = loadOidcRuntimeConfig(process.env);
  await probeOidcReadiness(config);
  process.stdout.write("OIDC readiness: discovery e JWKS validados.\n");
} catch (error) {
  const message = error instanceof Error ? error.message : "OIDC_READINESS_FAILED:UNKNOWN";
  process.stderr.write(`${message.startsWith("OIDC_") ? message : "OIDC_READINESS_FAILED:NETWORK"}\n`);
  process.exitCode = 1;
}
