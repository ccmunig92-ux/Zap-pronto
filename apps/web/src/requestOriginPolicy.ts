export function isExpectedBrowserOrigin(
  requestUrl: string,
  applicationOrigin: string,
  oidcIssuer: string | undefined,
): boolean {
  const requestOrigin = new URL(requestUrl).origin;
  if (requestOrigin === new URL(applicationOrigin).origin) return true;
  if (!oidcIssuer) return false;
  return requestOrigin === new URL(oidcIssuer).origin;
}
