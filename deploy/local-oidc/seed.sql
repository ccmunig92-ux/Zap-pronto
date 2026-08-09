BEGIN;
INSERT INTO tenants (id,name,status) VALUES ('90000000-0000-4000-8000-000000000001','Clínica Local','ACTIVE')
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,status='ACTIVE';
INSERT INTO units (id,tenant_id,code,name,active) VALUES
('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001','LOCAL','Unidade Local',true)
ON CONFLICT (tenant_id,code) DO UPDATE SET name=EXCLUDED.name,active=true;
INSERT INTO users (id,tenant_id,email,display_name,status) VALUES
('90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000001','admin.local@example.test','Admin Local','ACTIVE'),
('90000000-0000-4000-8000-000000000011','90000000-0000-4000-8000-000000000001','attendant.local@example.test','Atendente Local','ACTIVE')
ON CONFLICT (tenant_id,email) DO UPDATE SET display_name=EXCLUDED.display_name,status='ACTIVE',
blocked_at=NULL,revoked_at=NULL,status_changed_at=clock_timestamp();
INSERT INTO user_units (tenant_id,user_id,unit_id,role) VALUES
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000002','TENANT_ADMIN'),
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000011','90000000-0000-4000-8000-000000000002','ATTENDANT')
ON CONFLICT (tenant_id,user_id,unit_id) DO UPDATE SET role=EXCLUDED.role;
INSERT INTO oidc_providers (id,tenant_id,code,issuer,audience,organization_claim,organization_value,status,config_reference)
VALUES ('90000000-0000-4000-8000-000000000020','90000000-0000-4000-8000-000000000001','local',:'oidc_issuer',
'zap-pronto-local','org_id','local-tenant','ACTIVE','local-only://keycloak')
ON CONFLICT (tenant_id,code) DO UPDATE SET issuer=EXCLUDED.issuer,audience=EXCLUDED.audience,
organization_claim=EXCLUDED.organization_claim,organization_value=EXCLUDED.organization_value,status='ACTIVE';
INSERT INTO user_oidc_identities (tenant_id,user_id,oidc_provider_id,subject,status) VALUES
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000010','90000000-0000-4000-8000-000000000020','91000000-0000-4000-8000-000000000001','ACTIVE'),
('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000011','90000000-0000-4000-8000-000000000020','91000000-0000-4000-8000-000000000002','ACTIVE')
ON CONFLICT (tenant_id,oidc_provider_id,subject) DO UPDATE SET status='ACTIVE',revoked_at=NULL;
COMMIT;
