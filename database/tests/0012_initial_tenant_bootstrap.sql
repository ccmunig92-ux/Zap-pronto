BEGIN;

INSERT INTO tenants(id,name)
VALUES('f0000000-0000-4000-8000-000000000001','Preexisting tenant');
DO $$
DECLARE rejected boolean:=false;
BEGIN
  BEGIN
    PERFORM bootstrap_initial_tenant(
      'f1000000-0000-4000-8000-000000000001','Bootstrap tenant',
      'f2000000-0000-4000-8000-000000000001','BOOTSTRAP','Bootstrap unit',
      'f3000000-0000-4000-8000-000000000001','bootstrap-admin@example.test','Bootstrap admin',
      'f4000000-0000-4000-8000-000000000001','bootstrap','https://identity.example.test/',
      'zap-pronto','org_id','bootstrap-org','test-only://bootstrap','bootstrap-subject'
    );
  EXCEPTION WHEN check_violation THEN
    rejected:=SQLERRM='INITIAL_TENANT_BOOTSTRAP_REQUIRES_EMPTY_DATABASE';
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'INITIAL_BOOTSTRAP_NONEMPTY_DATABASE_ACCEPTED'; END IF;
END $$;

ROLLBACK;
BEGIN;

DO $$
DECLARE
  created record;
  replay record;
  rejected boolean:=false;
BEGIN
  SELECT * INTO created FROM bootstrap_initial_tenant(
    'f1000000-0000-4000-8000-000000000001','Bootstrap tenant',
    'f2000000-0000-4000-8000-000000000001','BOOTSTRAP','Bootstrap unit',
    'f3000000-0000-4000-8000-000000000001','bootstrap-admin@example.test','Bootstrap admin',
    'f4000000-0000-4000-8000-000000000001','bootstrap','https://identity.example.test/',
    'zap-pronto','org_id','bootstrap-org','test-only://bootstrap','bootstrap-subject'
  );
  IF created.replayed OR created.tenant_id<>'f1000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'INITIAL_BOOTSTRAP_CREATION_INVALID';
  END IF;

  SELECT * INTO replay FROM bootstrap_initial_tenant(
    'f1000000-0000-4000-8000-000000000001','Bootstrap tenant',
    'f2000000-0000-4000-8000-000000000001','BOOTSTRAP','Bootstrap unit',
    'f3000000-0000-4000-8000-000000000001','bootstrap-admin@example.test','Bootstrap admin',
    'f4000000-0000-4000-8000-000000000001','bootstrap','https://identity.example.test/',
    'zap-pronto','org_id','bootstrap-org','test-only://bootstrap','bootstrap-subject'
  );
  IF NOT replay.replayed OR replay.admin_user_id<>created.admin_user_id THEN
    RAISE EXCEPTION 'INITIAL_BOOTSTRAP_REPLAY_INVALID';
  END IF;

  UPDATE oidc_providers SET status='DISABLED'
  WHERE id='f4000000-0000-4000-8000-000000000001';
  BEGIN
    PERFORM bootstrap_initial_tenant(
      'f1000000-0000-4000-8000-000000000001','Bootstrap tenant',
      'f2000000-0000-4000-8000-000000000001','BOOTSTRAP','Bootstrap unit',
      'f3000000-0000-4000-8000-000000000001','bootstrap-admin@example.test','Bootstrap admin',
      'f4000000-0000-4000-8000-000000000001','bootstrap','https://identity.example.test/',
      'zap-pronto','org_id','bootstrap-org','test-only://bootstrap','bootstrap-subject'
    );
  EXCEPTION WHEN check_violation THEN
    rejected:=SQLERRM='INITIAL_TENANT_BOOTSTRAP_DRIFT';
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'INITIAL_BOOTSTRAP_DRIFT_ACCEPTED'; END IF;
  rejected:=false;
  UPDATE oidc_providers SET status='ACTIVE'
  WHERE id='f4000000-0000-4000-8000-000000000001';

  BEGIN
    PERFORM bootstrap_initial_tenant(
      'f1000000-0000-4000-8000-000000000001','Divergent tenant',
      'f2000000-0000-4000-8000-000000000001','BOOTSTRAP','Bootstrap unit',
      'f3000000-0000-4000-8000-000000000001','bootstrap-admin@example.test','Bootstrap admin',
      'f4000000-0000-4000-8000-000000000001','bootstrap','https://identity.example.test/',
      'zap-pronto','org_id','bootstrap-org','test-only://bootstrap','bootstrap-subject'
    );
  EXCEPTION WHEN unique_violation THEN
    rejected:=SQLERRM='INITIAL_TENANT_BOOTSTRAP_CONFLICT';
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'INITIAL_BOOTSTRAP_DIVERGENCE_ACCEPTED'; END IF;

  IF (SELECT count(*) FROM tenants WHERE id='f1000000-0000-4000-8000-000000000001')<>1
    OR (SELECT count(*) FROM units WHERE tenant_id='f1000000-0000-4000-8000-000000000001')<>1
    OR (SELECT count(*) FROM users WHERE tenant_id='f1000000-0000-4000-8000-000000000001')<>1
    OR (SELECT count(*) FROM user_units WHERE tenant_id='f1000000-0000-4000-8000-000000000001'
      AND role='TENANT_ADMIN' AND status='ACTIVE')<>1
    OR (SELECT count(*) FROM oidc_providers WHERE tenant_id='f1000000-0000-4000-8000-000000000001')<>1
    OR (SELECT count(*) FROM user_oidc_identities WHERE tenant_id='f1000000-0000-4000-8000-000000000001')<>1
    OR (SELECT count(*) FROM initial_tenant_bootstrap_commands)<>1
    OR (SELECT count(*) FROM audit_events WHERE tenant_id='f1000000-0000-4000-8000-000000000001'
      AND action='INITIAL_TENANT_BOOTSTRAPPED' AND actor_type='SYSTEM' AND actor_id IS NULL
      AND metadata->>'adminUserId'='f3000000-0000-4000-8000-000000000001')<>1 THEN
    RAISE EXCEPTION 'INITIAL_BOOTSTRAP_CARDINALITY_INVALID';
  END IF;
END $$;

DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['zap_pronto_app','zap_pronto_api','zap_pronto_worker'] LOOP
    IF has_table_privilege(role_name,'initial_tenant_bootstrap_commands','SELECT,INSERT,UPDATE,DELETE')
      OR has_function_privilege(role_name,
        'bootstrap_initial_tenant(uuid,text,uuid,text,text,uuid,text,text,uuid,text,text,text,text,text,text,text)',
        'EXECUTE') THEN
      RAISE EXCEPTION 'INITIAL_BOOTSTRAP_APPLICATION_PRIVILEGE_LEAK:%',role_name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_class relation
      CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl,acldefault('r',relation.relowner))) privilege
      WHERE relation.oid='initial_tenant_bootstrap_commands'::regclass AND privilege.grantee=0)
    OR EXISTS (SELECT 1 FROM pg_proc routine
      CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl,acldefault('f',routine.proowner))) privilege
      WHERE routine.oid='bootstrap_initial_tenant(uuid,text,uuid,text,text,uuid,text,text,uuid,text,text,text,text,text,text,text)'::regprocedure
        AND privilege.grantee=0) THEN
    RAISE EXCEPTION 'INITIAL_BOOTSTRAP_PUBLIC_PRIVILEGE_LEAK';
  END IF;
END $$;

COMMIT;
