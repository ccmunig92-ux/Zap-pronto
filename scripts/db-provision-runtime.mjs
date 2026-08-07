import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const MAX_SECRET_BYTES = 4096;
const RUNTIME_ROLE = "zap_pronto_runtime";
const SIMPLE_ROLE = /^[a-z][a-z0-9_]{0,62}$/;

async function valueFromEnvironment(env, directName, fileName) {
  const direct = env[directName]?.trim();
  const file = env[fileName]?.trim();
  if (direct && file) throw new Error(`${directName}_SOURCE_CONFLICT`);
  if (direct) return direct;
  if (!file) throw new Error(`${directName}_REQUIRED`);
  let value;
  try {
    value = await readFile(file, { encoding: "utf8" });
  } catch {
    throw new Error(`${fileName}_UNREADABLE`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new Error(`${fileName}_UNREADABLE`);
  value = value.trim();
  if (!value) throw new Error(`${directName}_REQUIRED`);
  return value;
}

function postgresUrl(raw, name) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name}_INVALID`);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error(`${name}_INVALID`);
  }
  if (!SIMPLE_ROLE.test(decodeURIComponent(parsed.username))) throw new Error(`${name}_USERNAME_INVALID`);
  if (!parsed.password) throw new Error(`${name}_PASSWORD_REQUIRED`);
  return parsed;
}

export async function loadProvisioningConfig(env = process.env) {
  const adminRaw = await valueFromEnvironment(env, "DATABASE_URL", "DATABASE_URL_FILE");
  const runtimeRaw = await valueFromEnvironment(env, "DATABASE_RUNTIME_URL", "DATABASE_RUNTIME_URL_FILE");
  const admin = postgresUrl(adminRaw, "DATABASE_URL");
  const runtime = postgresUrl(runtimeRaw, "DATABASE_RUNTIME_URL");
  if (decodeURIComponent(runtime.username) !== RUNTIME_ROLE) throw new Error("DATABASE_RUNTIME_URL_USERNAME_INVALID");
  const sameDatabase = admin.protocol === runtime.protocol && admin.hostname === runtime.hostname &&
    (admin.port || "5432") === (runtime.port || "5432") && admin.pathname === runtime.pathname;
  if (!sameDatabase) throw new Error("DATABASE_TARGET_MISMATCH");
  return { adminUrl: adminRaw, runtimePassword: decodeURIComponent(runtime.password), runtimeRole: RUNTIME_ROLE };
}

export async function provisionRuntime(config, Client = pg.Client) {
  const client = new Client({ connectionString: config.adminUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [820260807]);
    await client.query("SELECT set_config('zap_pronto.runtime_password', $1, true)", [config.runtimePassword]);
    await client.query(`
      DO $provision$
      DECLARE inherited_role name;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
          EXECUTE format(
            'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L',
            '${RUNTIME_ROLE}', current_setting('zap_pronto.runtime_password')
          );
        END IF;
        EXECUTE format(
          'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L',
          '${RUNTIME_ROLE}', current_setting('zap_pronto.runtime_password')
        );
        FOR inherited_role IN
          SELECT parent.rolname FROM pg_auth_members membership
          JOIN pg_roles member ON member.oid = membership.member
          JOIN pg_roles parent ON parent.oid = membership.roleid
          WHERE member.rolname = '${RUNTIME_ROLE}' AND parent.rolname <> 'zap_pronto_api'
        LOOP
          EXECUTE format('REVOKE %I FROM %I', inherited_role, '${RUNTIME_ROLE}');
        END LOOP;
      END
      $provision$;
      GRANT zap_pronto_api TO ${RUNTIME_ROLE};
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const config = await loadProvisioningConfig();
  await provisionRuntime(config);
  process.stdout.write("runtime role provisioned\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
