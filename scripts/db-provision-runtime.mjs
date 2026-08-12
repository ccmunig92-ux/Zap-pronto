import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";

const MAX_SECRET_BYTES = 4096;
const RUNTIME_ROLE = "zap_pronto_runtime";
const WORKER_RUNTIME_ROLE = "zap_pronto_worker_runtime";
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
  const workerRaw = await valueFromEnvironment(env, "DATABASE_WORKER_URL", "DATABASE_WORKER_URL_FILE");
  const admin = postgresUrl(adminRaw, "DATABASE_URL");
  const runtime = postgresUrl(runtimeRaw, "DATABASE_RUNTIME_URL");
  const worker = postgresUrl(workerRaw, "DATABASE_WORKER_URL");
  if (decodeURIComponent(runtime.username) !== RUNTIME_ROLE) throw new Error("DATABASE_RUNTIME_URL_USERNAME_INVALID");
  if (decodeURIComponent(worker.username) !== WORKER_RUNTIME_ROLE) throw new Error("DATABASE_WORKER_URL_USERNAME_INVALID");
  const sameDatabase = admin.protocol === runtime.protocol && admin.hostname === runtime.hostname &&
    (admin.port || "5432") === (runtime.port || "5432") && admin.pathname === runtime.pathname;
  if (!sameDatabase) throw new Error("DATABASE_TARGET_MISMATCH");
  const sameWorkerDatabase = admin.protocol === worker.protocol && admin.hostname === worker.hostname &&
    (admin.port || "5432") === (worker.port || "5432") && admin.pathname === worker.pathname;
  if (!sameWorkerDatabase) throw new Error("DATABASE_WORKER_TARGET_MISMATCH");
  return { adminUrl: adminRaw, runtimeUrl: runtimeRaw,
    runtimePassword: decodeURIComponent(runtime.password), runtimeRole: RUNTIME_ROLE,
    workerUrl: workerRaw, workerPassword: decodeURIComponent(worker.password), workerRuntimeRole: WORKER_RUNTIME_ROLE };
}

export async function provisionRuntime(config, Client = pg.Client) {
  const client = new Client({ connectionString: config.adminUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [820260807]);
    await client.query("SELECT set_config('zap_pronto.runtime_password', $1, true)", [config.runtimePassword]);
    await client.query("SELECT set_config('zap_pronto.worker_runtime_password', $1, true)", [config.workerPassword]);
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
          WHERE member.rolname = '${RUNTIME_ROLE}'
        LOOP
          EXECUTE format('REVOKE %I FROM %I', inherited_role, '${RUNTIME_ROLE}');
        END LOOP;
      END
      $provision$;
      DO $worker_provision$
      DECLARE inherited_role name;
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WORKER_RUNTIME_ROLE}') THEN
          EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L',
            '${WORKER_RUNTIME_ROLE}', current_setting('zap_pronto.worker_runtime_password'));
        END IF;
        EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD %L',
          '${WORKER_RUNTIME_ROLE}', current_setting('zap_pronto.worker_runtime_password'));
        FOR inherited_role IN SELECT parent.rolname FROM pg_auth_members membership
          JOIN pg_roles member ON member.oid=membership.member JOIN pg_roles parent ON parent.oid=membership.roleid
          WHERE member.rolname='${WORKER_RUNTIME_ROLE}' LOOP
          EXECUTE format('REVOKE %I FROM %I',inherited_role,'${WORKER_RUNTIME_ROLE}');
        END LOOP;
      END
      $worker_provision$;
      DO $database_revoke$
      BEGIN
        EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), '${RUNTIME_ROLE}');
        EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), '${WORKER_RUNTIME_ROLE}');
      END
      $database_revoke$;
      REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${RUNTIME_ROLE};
      REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${WORKER_RUNTIME_ROLE};
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${RUNTIME_ROLE};
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${WORKER_RUNTIME_ROLE};
      REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${RUNTIME_ROLE};
      REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${WORKER_RUNTIME_ROLE};
      REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM ${RUNTIME_ROLE};
      REVOKE ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public FROM ${WORKER_RUNTIME_ROLE};
      DO $type_revoke$
      DECLARE target_type record;
      BEGIN
        FOR target_type IN
          SELECT namespace.nspname, type.typname FROM pg_type type
          JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
          WHERE namespace.nspname = 'public'
            AND type.typelem = 0
            AND type.typrelid = 0
        LOOP
          EXECUTE format('REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM %I',
            target_type.nspname, target_type.typname, '${RUNTIME_ROLE}');
          EXECUTE format('REVOKE ALL PRIVILEGES ON TYPE %I.%I FROM %I',
            target_type.nspname, target_type.typname, '${WORKER_RUNTIME_ROLE}');
        END LOOP;
      END
      $type_revoke$;
      GRANT zap_pronto_api TO ${RUNTIME_ROLE} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
      GRANT zap_pronto_worker TO ${WORKER_RUNTIME_ROLE} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
    `);
    const verification = await client.query(`
      WITH runtime AS (
        SELECT oid FROM pg_roles WHERE rolname IN ('${RUNTIME_ROLE}','${WORKER_RUNTIME_ROLE}')
      ), direct_acl AS (
        SELECT privilege_type FROM pg_database object, LATERAL aclexplode(object.datacl) acl, runtime
          WHERE acl.grantee = runtime.oid
        UNION ALL SELECT privilege_type FROM pg_namespace object, LATERAL aclexplode(object.nspacl) acl, runtime
          WHERE acl.grantee = runtime.oid
        UNION ALL SELECT privilege_type FROM pg_class object, LATERAL aclexplode(object.relacl) acl, runtime
          WHERE acl.grantee = runtime.oid
        UNION ALL SELECT privilege_type FROM pg_attribute object,
          LATERAL aclexplode(object.attacl) acl, runtime WHERE acl.grantee = runtime.oid
        UNION ALL SELECT privilege_type FROM pg_proc object, LATERAL aclexplode(object.proacl) acl, runtime
          WHERE acl.grantee = runtime.oid
        UNION ALL SELECT privilege_type FROM pg_type object, LATERAL aclexplode(object.typacl) acl, runtime
          WHERE acl.grantee = runtime.oid AND object.typelem = 0 AND object.typrelid = 0
        UNION ALL SELECT privilege_type FROM pg_language object,
          LATERAL aclexplode(object.lanacl) acl, runtime WHERE acl.grantee = runtime.oid
        UNION ALL SELECT privilege_type FROM pg_largeobject_metadata object,
          LATERAL aclexplode(object.lomacl) acl, runtime WHERE acl.grantee = runtime.oid
        UNION ALL SELECT privilege_type FROM pg_foreign_data_wrapper object,
          LATERAL aclexplode(object.fdwacl) acl, runtime WHERE acl.grantee = runtime.oid
        UNION ALL SELECT privilege_type FROM pg_foreign_server object,
          LATERAL aclexplode(object.srvacl) acl, runtime WHERE acl.grantee = runtime.oid
        UNION ALL SELECT privilege_type FROM pg_parameter_acl object,
          LATERAL aclexplode(object.paracl) acl, runtime WHERE acl.grantee = runtime.oid
        UNION ALL SELECT privilege_type FROM pg_default_acl object,
          LATERAL aclexplode(object.defaclacl) acl, runtime WHERE acl.grantee = runtime.oid
      ), owned_objects AS (
        SELECT pg_database.oid FROM pg_database, runtime WHERE datdba = runtime.oid
        UNION ALL SELECT pg_namespace.oid FROM pg_namespace, runtime WHERE nspowner = runtime.oid
        UNION ALL SELECT pg_class.oid FROM pg_class, runtime WHERE relowner = runtime.oid
        UNION ALL SELECT pg_proc.oid FROM pg_proc, runtime WHERE proowner = runtime.oid
        UNION ALL SELECT pg_type.oid FROM pg_type, runtime WHERE typowner = runtime.oid
        UNION ALL SELECT pg_language.oid FROM pg_language, runtime WHERE lanowner = runtime.oid
        UNION ALL SELECT pg_largeobject_metadata.oid FROM pg_largeobject_metadata, runtime
          WHERE lomowner = runtime.oid
        UNION ALL SELECT pg_foreign_data_wrapper.oid FROM pg_foreign_data_wrapper, runtime
          WHERE fdwowner = runtime.oid
        UNION ALL SELECT pg_foreign_server.oid FROM pg_foreign_server, runtime WHERE srvowner = runtime.oid
        UNION ALL SELECT pg_tablespace.oid FROM pg_tablespace, runtime WHERE spcowner = runtime.oid
      )
      SELECT
        (SELECT count(*)::integer FROM pg_auth_members membership
          JOIN pg_roles member ON member.oid = membership.member
          JOIN pg_roles parent ON parent.oid = membership.roleid
          WHERE member.rolname = '${RUNTIME_ROLE}' AND parent.rolname = 'zap_pronto_api'
            AND membership.admin_option = false AND membership.inherit_option = false
            AND membership.set_option = true) AS valid_membership_count,
        (SELECT count(*)::integer FROM pg_auth_members membership
          JOIN pg_roles member ON member.oid = membership.member
          WHERE member.rolname = '${RUNTIME_ROLE}') AS total_membership_count,
        (SELECT count(*)::integer FROM direct_acl) AS direct_acl_count,
        (SELECT count(*)::integer FROM owned_objects) AS owned_object_count,
        (SELECT count(*)::integer FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}' AND rolcanlogin
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
          AND NOT rolbypassrls AND NOT rolinherit) AS hardened_role_count,
        (SELECT count(*)::integer FROM pg_auth_members membership JOIN pg_roles member ON member.oid=membership.member
          JOIN pg_roles parent ON parent.oid=membership.roleid WHERE member.rolname='${WORKER_RUNTIME_ROLE}'
          AND parent.rolname='zap_pronto_worker' AND NOT membership.admin_option AND NOT membership.inherit_option
          AND membership.set_option) AS worker_valid_membership_count,
        (SELECT count(*)::integer FROM pg_auth_members membership JOIN pg_roles member ON member.oid=membership.member
          WHERE member.rolname='${WORKER_RUNTIME_ROLE}') AS worker_total_membership_count,
        (SELECT count(*)::integer FROM pg_roles WHERE rolname='${WORKER_RUNTIME_ROLE}' AND rolcanlogin
          AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
          AND NOT rolbypassrls AND NOT rolinherit) AS worker_hardened_role_count
    `);
    const state = verification.rows[0];
    if (!state || state.valid_membership_count !== 1 || state.total_membership_count !== 1 ||
      state.direct_acl_count !== 0 || state.owned_object_count !== 0 || state.hardened_role_count !== 1 ||
      state.worker_valid_membership_count !== 1 || state.worker_total_membership_count !== 1 ||
      state.worker_hardened_role_count !== 1) {
      throw new Error("RUNTIME_ROLE_PRIVILEGE_DRIFT");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  const runtimeClient = new Client({ connectionString: config.runtimeUrl });
  await runtimeClient.connect();
  try {
    await runtimeClient.query("BEGIN");
    await runtimeClient.query("SET LOCAL ROLE zap_pronto_api");
    const identity = await runtimeClient.query(
      "SELECT session_user = $1 AS session_is_runtime, current_user = 'zap_pronto_api' AS role_is_api",
      [RUNTIME_ROLE],
    );
    if (identity.rows[0]?.session_is_runtime !== true || identity.rows[0]?.role_is_api !== true) {
      throw new Error("RUNTIME_ROLE_CONNECTION_INVALID");
    }
    await runtimeClient.query("ROLLBACK");
  } catch (error) {
    await runtimeClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await runtimeClient.end();
  }

  const workerClient = new Client({ connectionString: config.workerUrl });
  await workerClient.connect();
  try {
    await workerClient.query("BEGIN");await workerClient.query("SET LOCAL ROLE zap_pronto_worker");
    const identity=await workerClient.query(
      "SELECT session_user = $1 AS session_is_runtime, current_user = 'zap_pronto_worker' AS role_is_worker",
      [WORKER_RUNTIME_ROLE]);
    if(identity.rows[0]?.session_is_runtime!==true||identity.rows[0]?.role_is_worker!==true)
      throw new Error("WORKER_RUNTIME_ROLE_CONNECTION_INVALID");
    await workerClient.query("ROLLBACK");
  } catch(error){await workerClient.query("ROLLBACK").catch(()=>undefined);throw error;}
  finally{await workerClient.end();}
}

async function main() {
  const config = await loadProvisioningConfig();
  await provisionRuntime(config);
  process.stdout.write("runtime role provisioned\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
