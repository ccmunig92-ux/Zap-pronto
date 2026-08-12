[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('Setup','Up','Verify','E2E','Down','Destroy','Untrust')][string]$Action)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'ZapPronto\local-oidc-runtime'
$tlsRoot = Join-Path $env:LOCALAPPDATA 'ZapPronto\local-oidc-tls'
$envFile = Join-Path $runtimeRoot 'local.env'
$markerFile = Join-Path $tlsRoot 'trust-marker.json'
$harnessMarkerFile = Join-Path $runtimeRoot 'harness-marker.json'
$hostname = 'zap-pronto.127.0.0.1.nip.io'
$origin = 'https://' + $hostname + ':18443'
$projectName = 'zap-pronto-local-oidc'
$openssl = 'C:\Program Files\Git\usr\bin\openssl.exe'
$composeFiles = @('-f',(Join-Path $repoRoot 'deploy\staging\compose.yaml'),'-f',(Join-Path $repoRoot 'deploy\local-oidc\compose.yaml'))

function Invoke-Checked([string]$Command,[string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "COMMAND_FAILED:$Command" }
}
function Assert-LocalPrerequisites([switch]$ForE2E) {
  foreach($command in @('node','corepack','pnpm','docker')){if(-not(Get-Command $command -ErrorAction SilentlyContinue)){throw "LOCAL_OIDC_PREREQUISITE_REQUIRED:$command"}}
  $nodeVersion=(& node --version|Out-String).Trim()
  if($LASTEXITCODE-ne 0-or $nodeVersion-notmatch '^v(?<major>\d+)\.'-or [int]$Matches.major-lt 24){throw 'LOCAL_OIDC_NODE_24_REQUIRED'}
  & corepack --version *> $null;if($LASTEXITCODE-ne 0){throw 'LOCAL_OIDC_COREPACK_UNAVAILABLE'}
  & pnpm --version *> $null;if($LASTEXITCODE-ne 0){throw 'LOCAL_OIDC_PNPM_UNAVAILABLE'}
  & docker info *> $null;if($LASTEXITCODE-ne 0){throw 'LOCAL_OIDC_DOCKER_DAEMON_REQUIRED'}
  & docker compose version *> $null;if($LASTEXITCODE-ne 0){throw 'LOCAL_OIDC_DOCKER_COMPOSE_REQUIRED'}
  if(-not(Test-Path -LiteralPath $openssl -PathType Leaf)){throw 'OPENSSL_REQUIRED'}
  & $openssl version *> $null;if($LASTEXITCODE-ne 0){throw 'OPENSSL_UNAVAILABLE'}
  if($ForE2E){
    & pnpm --filter '@zap-pronto/web' exec playwright --version *> $null;if($LASTEXITCODE-ne 0){throw 'LOCAL_OIDC_E2E_DEPENDENCIES_REQUIRED'}
    $browserPath=(& pnpm --filter '@zap-pronto/web' exec node --input-type=module -e "import { chromium } from '@playwright/test'; process.stdout.write(chromium.executablePath())"|Out-String).Trim()
    if($LASTEXITCODE-ne 0-or-not $browserPath-or-not(Test-Path -LiteralPath $browserPath -PathType Leaf)){throw 'LOCAL_OIDC_CHROMIUM_REQUIRED'}
  }
}
function Test-CertificateSet([string]$Ca,[string]$CaKey,[string]$Cert,[string]$Key) {
  if(@(@($Ca,$CaKey,$Cert,$Key)|Where-Object{-not(Test-Path -LiteralPath $_ -PathType Leaf)}).Count-ne 0){return $false}
  & $openssl x509 -checkend 604800 -noout -in $Ca *> $null;if($LASTEXITCODE-ne 0){return $false}
  & $openssl x509 -checkend 604800 -noout -in $Cert *> $null;if($LASTEXITCODE-ne 0){return $false}
  $san=(& $openssl x509 -noout -ext subjectAltName -in $Cert|Out-String);if($LASTEXITCODE-ne 0-or $san-notmatch "DNS:$([regex]::Escape($hostname))(?:\s|,|$)"){return $false}
  & $openssl verify -CAfile $Ca $Cert *> $null;if($LASTEXITCODE-ne 0){return $false}
  $certPublic=(& $openssl x509 -pubkey -noout -in $Cert|Out-String).Trim();$keyPublic=(& $openssl pkey -pubout -in $Key|Out-String).Trim()
  $caPublic=(& $openssl x509 -pubkey -noout -in $Ca|Out-String).Trim();$caKeyPublic=(& $openssl pkey -pubout -in $CaKey|Out-String).Trim()
  $LASTEXITCODE-eq 0-and $certPublic-and $certPublic-eq$keyPublic-and $caPublic-and $caPublic-eq$caKeyPublic
}
function Initialize-LocalCertificates([string]$Ca,[string]$CaKey,[string]$Cert,[string]$Key) {
  if(Test-CertificateSet $Ca $CaKey $Cert $Key){return}
  $candidate=Join-Path $tlsRoot ('.candidate-'+[guid]::NewGuid().ToString('N'));$backup=Join-Path $tlsRoot ('.backup-'+[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $candidate,$backup|Out-Null
  $candidateCa=Join-Path $candidate 'ca.crt';$candidateCaKey=Join-Path $candidate 'ca.key';$candidateCert=Join-Path $candidate 'tls.crt';$candidateKey=Join-Path $candidate 'tls.key';$csr=Join-Path $candidate 'tls.csr'
  try{
    Invoke-Checked $openssl @('req','-x509','-newkey','rsa:3072','-sha256','-nodes','-keyout',$candidateCaKey,'-out',$candidateCa,'-subj','/CN=Zap Pronto Local Development CA','-days','30')
    Invoke-Checked $openssl @('req','-newkey','rsa:3072','-sha256','-nodes','-keyout',$candidateKey,'-out',$csr,'-subj',"/CN=$hostname",'-addext',"subjectAltName=DNS:$hostname")
    Invoke-Checked $openssl @('x509','-req','-in',$csr,'-CA',$candidateCa,'-CAkey',$candidateCaKey,'-CAcreateserial','-out',$candidateCert,'-days','30','-sha256','-copy_extensions','copy')
    if(-not(Test-CertificateSet $candidateCa $candidateCaKey $candidateCert $candidateKey)){throw 'LOCAL_OIDC_CERTIFICATE_GENERATION_INVALID'}
    foreach($path in @($Ca,$CaKey,$Cert,$Key)){if(Test-Path -LiteralPath $path){Move-Item -LiteralPath $path -Destination $backup}}
    try{
      Move-Item -LiteralPath $candidateCa -Destination $Ca;Move-Item -LiteralPath $candidateCaKey -Destination $CaKey;Move-Item -LiteralPath $candidateCert -Destination $Cert;Move-Item -LiteralPath $candidateKey -Destination $Key
      if(-not(Test-CertificateSet $Ca $CaKey $Cert $Key)){throw 'LOCAL_OIDC_CERTIFICATE_REPLACEMENT_INVALID'}
    }catch{
      foreach($path in @($Ca,$CaKey,$Cert,$Key)){if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Force}}
      foreach($name in @('ca.crt','ca.key','tls.crt','tls.key')){$saved=Join-Path $backup $name;if(Test-Path -LiteralPath $saved){Move-Item -LiteralPath $saved -Destination (Join-Path $tlsRoot $name)}}
      throw
    }
  }finally{Remove-Item -LiteralPath $candidate,$backup -Recurse -Force -ErrorAction SilentlyContinue}
}
function Assert-ExternalRoot([string]$Path) {
  $resolved=[IO.Path]::GetFullPath($Path).TrimEnd('\')+'\'
  $repo=$repoRoot.TrimEnd('\')+'\'
  if($resolved.StartsWith($repo,[StringComparison]::OrdinalIgnoreCase)-or $repo.StartsWith($resolved,[StringComparison]::OrdinalIgnoreCase)){
    throw 'LOCAL_OIDC_EXTERNAL_ROOT_REQUIRED'
  }
}
function New-RandomSecret {
  [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(30)).Replace('/','A').Replace('+','B').TrimEnd('=')
}
function Read-LocalEnvironment {
  if(-not(Test-Path -LiteralPath $envFile -PathType Leaf)){throw 'LOCAL_OIDC_SETUP_REQUIRED'}
  $values=@{}
  foreach($line in Get-Content -LiteralPath $envFile){
    if(-not $line -or $line.StartsWith('#')){continue}
    $parts=$line.Split('=',2)
    if($parts.Count-ne 2-or $values.ContainsKey($parts[0])){throw 'LOCAL_OIDC_ENV_INVALID'}
    $values[$parts[0]]=$parts[1]
  }
  $values
}
function Assert-HarnessMarker {
  if(-not(Test-Path -LiteralPath $harnessMarkerFile -PathType Leaf)){throw 'LOCAL_HARNESS_MARKER_REQUIRED'}
  $marker=Get-Content -Raw -LiteralPath $harnessMarkerFile|ConvertFrom-Json;$values=Read-LocalEnvironment
  if($marker.repoPath-ne$repoRoot-or$marker.projectName-ne$projectName-or$marker.nonce-ne$values.LOCAL_HARNESS_NONCE-or
    $marker.stagingComposeSha256-ne(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repoRoot 'deploy\staging\compose.yaml')).Hash-or
    $marker.localComposeSha256-ne(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repoRoot 'deploy\local-oidc\compose.yaml')).Hash){throw 'LOCAL_HARNESS_MARKER_MISMATCH'}
}
function Assert-ProjectResources {
  $allowedContainers=@('postgres','migrate','provision-runtime','local-seed','keycloak','api','web','local-edge')|ForEach-Object{"$projectName-$_-1"}
  $containers=@(& docker ps -a --filter "label=com.docker.compose.project=$projectName" --format '{{.Names}}')
  if($LASTEXITCODE-ne 0-or@($containers|Where-Object{$_-and$_-notin$allowedContainers}).Count-ne 0){throw 'LOCAL_HARNESS_UNEXPECTED_CONTAINER'}
  $allowedVolumes=@("${projectName}_postgres_data","${projectName}_keycloak_data")
  $volumes=@(& docker volume ls --filter "label=com.docker.compose.project=$projectName" --format '{{.Name}}')
  if($LASTEXITCODE-ne 0-or@($volumes|Where-Object{$_-and$_-notin$allowedVolumes}).Count-ne 0){throw 'LOCAL_HARNESS_UNEXPECTED_VOLUME'}
  foreach($volume in $volumes){$label=& docker volume inspect $volume --format '{{index .Labels "com.docker.compose.project"}}';if($label-ne$projectName){throw 'LOCAL_HARNESS_VOLUME_LABEL_MISMATCH'}}
}
function Compose([string[]]$Arguments) {
  Invoke-Checked 'docker' (@('compose','--project-name',$projectName,'--env-file',$envFile)+$composeFiles+$Arguments)
}
function Read-InboxSnapshot {
  $arguments=@('compose','--project-name',$projectName,'--env-file',$envFile)+$composeFiles+@('exec','-T','postgres','psql','--username','zap_pronto_owner','--dbname','zap_pronto','--tuples-only','--no-align','--command',
    "SELECT encode(digest(jsonb_build_object('conversation',(SELECT jsonb_agg(jsonb_build_array(id,status,automation_status,assigned_user_id,version,updated_at) ORDER BY id) FROM conversations),'handoff',(SELECT jsonb_agg(jsonb_build_array(id,status,assigned_user_id,version,claimed_at,queued_at) ORDER BY id) FROM human_handoffs),'messages',(SELECT jsonb_agg(jsonb_build_array(id,direction,actor,encode(digest(coalesce(body,''),'sha256'),'hex')) ORDER BY id) FROM messages),'outbox',(SELECT jsonb_agg(jsonb_build_array(id,status,published_at,attempts,event_type) ORDER BY id) FROM outbox_events),'audit',(SELECT jsonb_build_array(count(*),coalesce(max(id),0)) FROM audit_events))::text,'sha256'),'hex')")
  $value=(& docker @arguments|Out-String).Trim();if($LASTEXITCODE -ne 0 -or $value -notmatch '^[a-f0-9]{64}$'){throw 'LOCAL_OIDC_INBOX_SNAPSHOT_FAILED'};$value
}
function Read-InboxImmutableSnapshot {
  $arguments=@('compose','--project-name',$projectName,'--env-file',$envFile)+$composeFiles+@('exec','-T','postgres','psql','--username','zap_pronto_owner','--dbname','zap_pronto','--tuples-only','--no-align','--command',
    "SELECT encode(digest(jsonb_build_object('messages',(SELECT jsonb_agg(jsonb_build_array(id,direction,actor,encode(digest(coalesce(body,''),'sha256'),'hex')) ORDER BY id) FROM messages WHERE direction='INBOUND'),'outbox',(SELECT jsonb_agg(jsonb_build_array(id,status,published_at,attempts,event_type) ORDER BY id) FROM outbox_events WHERE event_type NOT IN ('handoff.claimed','channel.outbound.requested')),'audit',(SELECT jsonb_build_array(count(*),coalesce(max(id),0)) FROM audit_events WHERE action NOT IN ('HUMAN_TEXT_MESSAGE_QUEUED','HUMAN_TEXT_MESSAGE_CANCELLED')))::text,'sha256'),'hex')")
  $value=(& docker @arguments|Out-String).Trim();if($LASTEXITCODE -ne 0 -or $value -notmatch '^[a-f0-9]{64}$'){throw 'LOCAL_OIDC_IMMUTABLE_SNAPSHOT_FAILED'};$value
}
function Setup {
  Assert-LocalPrerequisites
  Assert-ExternalRoot $runtimeRoot; Assert-ExternalRoot $tlsRoot
  New-Item -ItemType Directory -Force -Path $runtimeRoot,$tlsRoot|Out-Null
  Invoke-Checked 'icacls' @($runtimeRoot,'/inheritance:r','/grant:r',"$($env:USERNAME):(OI)(CI)F")
  Invoke-Checked 'icacls' @($tlsRoot,'/inheritance:r','/grant:r',"$($env:USERNAME):(OI)(CI)F")
  $ca=Join-Path $tlsRoot 'ca.crt'; $caKey=Join-Path $tlsRoot 'ca.key'
  $cert=Join-Path $tlsRoot 'tls.crt'; $key=Join-Path $tlsRoot 'tls.key'
  $previousTrusted=$null
  if((Test-Path -LiteralPath $markerFile -PathType Leaf)-and(Test-Path -LiteralPath $ca -PathType Leaf)){
    $previousMarker=Get-Content -Raw -LiteralPath $markerFile|ConvertFrom-Json
    if($previousMarker.certificate-eq$ca-and $previousMarker.sha256-eq(Get-FileHash -Algorithm SHA256 -LiteralPath $ca).Hash){$previousTrusted=[Security.Cryptography.X509Certificates.X509Certificate2]::new($ca)}
  }
  Initialize-LocalCertificates $ca $caKey $cert $key
  $source=[Security.Cryptography.X509Certificates.X509Certificate2]::new($ca)
  $store=[Security.Cryptography.X509Certificates.X509Store]::new('Root',[Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
  try{$store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite);if(@($store.Certificates|Where-Object Thumbprint -eq $source.Thumbprint).Count-eq 0){$store.Add($source)}}finally{$store.Close()}
  $trusted=@(Get-ChildItem Cert:\CurrentUser\Root|Where-Object Thumbprint -eq $source.Thumbprint)
  if($trusted.Count-ne 1-or $trusted[0].HasPrivateKey-or [Convert]::ToBase64String($trusted[0].RawData)-ne [Convert]::ToBase64String($source.RawData)){throw 'LOCAL_CA_TRUST_VERIFICATION_FAILED'}
  $markerCandidate=Join-Path $tlsRoot ('.trust-marker-'+[guid]::NewGuid().ToString('N')+'.json')
  try{@{thumbprint=$source.Thumbprint;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $ca).Hash;certificate=$ca}|ConvertTo-Json|Set-Content -LiteralPath $markerCandidate -Encoding utf8;Move-Item -LiteralPath $markerCandidate -Destination $markerFile -Force}finally{Remove-Item -LiteralPath $markerCandidate -Force -ErrorAction SilentlyContinue}
  if($previousTrusted-and $previousTrusted.Thumbprint-ne$source.Thumbprint){
    $oldStore=[Security.Cryptography.X509Certificates.X509Store]::new('Root',[Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    try{$oldStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite);foreach($old in @($oldStore.Certificates|Where-Object Thumbprint -eq $previousTrusted.Thumbprint)){if([Convert]::ToBase64String($old.RawData) -eq [Convert]::ToBase64String($previousTrusted.RawData)){$oldStore.Remove($old)}}}finally{$oldStore.Close()}
  }
  if(-not(Test-Path -LiteralPath $envFile)){
    $pg=New-RandomSecret;$runtime=New-RandomSecret;$admin=New-RandomSecret;$attendant=New-RandomSecret;$attendantTwo=New-RandomSecret
    Set-Content -LiteralPath (Join-Path $runtimeRoot 'postgres-password') -NoNewline -Value $pg
    Set-Content -LiteralPath (Join-Path $runtimeRoot 'database-migration-url') -NoNewline -Value "postgresql://zap_pronto_owner:$pg@postgres:5432/zap_pronto"
    Set-Content -LiteralPath (Join-Path $runtimeRoot 'database-runtime-url') -NoNewline -Value "postgresql://zap_pronto_runtime:$runtime@postgres:5432/zap_pronto"
    @('ZAP_API_IMAGE=zap-pronto-api:local','ZAP_WEB_IMAGE=zap-pronto-web:local','POSTGRES_IMAGE=postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7','POSTGRES_DB=zap_pronto','POSTGRES_USER=zap_pronto_owner',
      "POSTGRES_PASSWORD_FILE=$((Join-Path $runtimeRoot 'postgres-password').Replace('\','/'))",
      "DATABASE_MIGRATION_URL_FILE=$((Join-Path $runtimeRoot 'database-migration-url').Replace('\','/'))",
      "DATABASE_RUNTIME_URL_FILE=$((Join-Path $runtimeRoot 'database-runtime-url').Replace('\','/'))",
      "LOCAL_OIDC_HOST=$hostname",'LOCAL_HTTPS_PORT=18443',"LOCAL_OIDC_ORIGIN=$origin",'LOCAL_KEYCLOAK_ADMIN_USERNAME=local-admin',
      "LOCAL_KEYCLOAK_ADMIN_PASSWORD=$(New-RandomSecret)","LOCAL_OIDC_ADMIN_PASSWORD=$admin", "LOCAL_OIDC_ATTENDANT_PASSWORD=$attendant","LOCAL_OIDC_ATTENDANT_TWO_PASSWORD=$attendantTwo",
      "LOCAL_TLS_CA_FILE=$($ca.Replace('\','/'))","LOCAL_TLS_CERT_FILE=$($cert.Replace('\','/'))","LOCAL_TLS_KEY_FILE=$($key.Replace('\','/'))",
      "OIDC_ISSUER=$origin/realms/zap-pronto-local","OIDC_AUTHORITY_ORIGIN=$origin",'OIDC_AUDIENCE=zap-pronto-local',
      "OIDC_JWKS_URL=$origin/realms/zap-pronto-local/protocol/openid-connect/certs",
      "OIDC_DISCOVERY_URL=$origin/realms/zap-pronto-local/.well-known/openid-configuration",'OIDC_ORGANIZATION_CLAIM=org_id')|Set-Content -LiteralPath $envFile -Encoding utf8
  }
  $existing=Read-LocalEnvironment
  if(-not $existing.ContainsKey('LOCAL_OIDC_ATTENDANT_TWO_PASSWORD')){
    Add-Content -LiteralPath $envFile -Value "LOCAL_OIDC_ATTENDANT_TWO_PASSWORD=$(New-RandomSecret)"
    $existing=Read-LocalEnvironment
  }
  if(-not $existing.ContainsKey('DATABASE_WORKER_URL_FILE')){
    $worker=New-RandomSecret;$workerFile=Join-Path $runtimeRoot 'database-worker-url'
    Set-Content -LiteralPath $workerFile -NoNewline -Value "postgresql://zap_pronto_worker_runtime:$worker@postgres:5432/zap_pronto"
    Add-Content -LiteralPath $envFile -Value "DATABASE_WORKER_URL_FILE=$($workerFile.Replace('\','/'))"
  }
  $existing=Read-LocalEnvironment;if(-not $existing.ContainsKey('LOCAL_HARNESS_NONCE')){Add-Content -LiteralPath $envFile -Value "LOCAL_HARNESS_NONCE=$([Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).Replace('/','_').Replace('+','-').TrimEnd('='))";$existing=Read-LocalEnvironment}
  @{repoPath=$repoRoot;projectName=$projectName;nonce=$existing.LOCAL_HARNESS_NONCE;
    stagingComposeSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repoRoot 'deploy\staging\compose.yaml')).Hash;
    localComposeSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repoRoot 'deploy\local-oidc\compose.yaml')).Hash}|ConvertTo-Json|Set-Content -LiteralPath $harnessMarkerFile -Encoding utf8
  'local OIDC setup ready'
}
function Verify {
  $null=Read-LocalEnvironment;Assert-HarnessMarker;Assert-ProjectResources;Compose @('config','--quiet')
  $discovery=Invoke-RestMethod -Uri "$origin/realms/zap-pronto-local/.well-known/openid-configuration"
  if($discovery.issuer-ne"$origin/realms/zap-pronto-local"-or-not @($discovery.code_challenge_methods_supported).Contains('S256')){throw 'LOCAL_OIDC_DISCOVERY_INVALID'}
  $jwks=Invoke-RestMethod -Uri $discovery.jwks_uri;if(@($jwks.keys).Count-lt 1){throw 'LOCAL_OIDC_JWKS_INVALID'}
  $live=Invoke-RestMethod -Uri "$origin/health/live";if($live.status-ne'ok'){throw 'LOCAL_OIDC_API_UNHEALTHY'}
  'local OIDC verify passed'
}
function Up {
  Assert-LocalPrerequisites
  $null=Read-LocalEnvironment;Assert-HarnessMarker;Assert-ProjectResources
  Invoke-Checked 'docker' @('build','-f','Dockerfile.api','-t','zap-pronto-api:local','.')
  Invoke-Checked 'docker' @('build','-f','Dockerfile.web','-t','zap-pronto-web:local','--build-arg',"VITE_OIDC_AUTHORITY=$origin/realms/zap-pronto-local",'--build-arg','VITE_OIDC_CLIENT_ID=zap-pronto-local','--build-arg',"VITE_OIDC_REDIRECT_URI=$origin/",'--build-arg',"VITE_OIDC_POST_LOGOUT_REDIRECT_URI=$origin/",'--build-arg','VITE_OIDC_SCOPE=openid profile email','--build-arg','VITE_OIDC_AUTOMATIC_SILENT_RENEW=true','.')
  Compose @('up','-d','--remove-orphans','--wait');Verify
}
function E2E {
  Assert-LocalPrerequisites -ForE2E
  $v=Read-LocalEnvironment;Assert-HarnessMarker;Assert-ProjectResources
  $vars=@{E2E_OIDC_ENABLED='true';E2E_OIDC_TARGET='local';E2E_LOCAL_DESTRUCTIVE_ALLOWED='true';E2E_LOCAL_INSTANCE_NONCE=$v.LOCAL_HARNESS_NONCE;E2E_BASE_URL=$origin;E2E_REQUIRE_RENEWAL='true';E2E_REQUIRE_BLOCK_REVOCATION='true';E2E_RENEW_WAIT_SECONDS='45';E2E_OIDC_TEST_TIMEOUT_MS='240000';E2E_OIDC_USERNAME_SELECTOR='#username';E2E_OIDC_PASSWORD_SELECTOR='#password';E2E_OIDC_SUBMIT_SELECTOR='#kc-login';E2E_ADMIN_USERNAME='admin.local';E2E_ADMIN_PASSWORD=$v.LOCAL_OIDC_ADMIN_PASSWORD;E2E_ADMIN_EXPECTED_TENANT='Clínica Local';E2E_ATTENDANT_USERNAME='attendant.local';E2E_ATTENDANT_PASSWORD=$v.LOCAL_OIDC_ATTENDANT_PASSWORD;E2E_ATTENDANT_EXPECTED_TENANT='Clínica Local';E2E_ATTENDANT_TWO_USERNAME='attendant.two.local';E2E_ATTENDANT_TWO_PASSWORD=$v.LOCAL_OIDC_ATTENDANT_TWO_PASSWORD;E2E_ATTENDANT_TWO_EXPECTED_TENANT='Clínica Local';E2E_ATTENDANT_ADMIN_LIST_MATCH='attendant.local@example.test';E2E_ATTENDANT_TWO_ADMIN_LIST_MATCH='attendant.two.local@example.test';E2E_MANAGER_USERNAME='attendant.two.local';E2E_MANAGER_PASSWORD=$v.LOCAL_OIDC_ATTENDANT_TWO_PASSWORD;E2E_MANAGER_EXPECTED_TENANT='Clínica Local';E2E_MANAGER_MEMBERSHIP_MATCH='attendant.local'}
  try{foreach($entry in $vars.GetEnumerator()){Set-Item "Env:$($entry.Key)" $entry.Value};Compose @('run','--rm','local-seed');$before=Read-InboxSnapshot;$beforeImmutable=Read-InboxImmutableSnapshot
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','inbound materializado')
    $after=Read-InboxSnapshot;if($after-eq$before){throw 'LOCAL_OIDC_CLAIM_DID_NOT_MUTATE_EXPECTED_STATE'}
    $claimState=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM human_handoffs h JOIN conversations c ON c.tenant_id=h.tenant_id AND c.id=h.conversation_id JOIN service_cases s ON s.tenant_id=h.tenant_id AND s.id=h.service_case_id WHERE h.id='90000000-0000-4000-8000-000000000060' AND h.status='QUEUED' AND h.version=3 AND h.assigned_user_id IS NULL AND h.claimed_at IS NULL AND c.status='OPEN' AND c.automation_status='HUMAN_QUEUED' AND c.assigned_user_id IS NULL AND s.status='WAITING_HUMAN'; SELECT count(*) FROM outbox_events WHERE aggregate_id='90000000-0000-4000-8000-000000000060' AND event_type='handoff.claimed'; SELECT count(*) FROM outbox_events WHERE aggregate_id='90000000-0000-4000-8000-000000000060' AND event_type='handoff.requeued'"
    if(@($claimState|Where-Object{$_-ne'1'}).Count-ne 0){throw 'LOCAL_OIDC_CLAIM_REQUEUE_STATE_INVALID'}
    $forbidden=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM messages WHERE direction='OUTBOUND' OR actor='HERMES'; SELECT count(*) FROM outbox_events WHERE event_type~*'(send|hermes)'";if(@($forbidden|Where-Object{$_-ne'0'}).Count-ne 0){throw 'LOCAL_OIDC_FORBIDDEN_OUTBOUND_OR_HERMES'}
    Compose @('run','--rm','local-seed');$beforeSend=Read-InboxSnapshot;$beforeSendImmutable=Read-InboxImmutableSnapshot
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','resposta humana TEXT')
    $afterSend=Read-InboxSnapshot;if($afterSend-eq$beforeSend){throw 'LOCAL_OIDC_HUMAN_TEXT_DID_NOT_MUTATE_EXPECTED_STATE'}
    $afterSendImmutable=Read-InboxImmutableSnapshot;if($afterSendImmutable-ne$beforeSendImmutable){throw 'LOCAL_OIDC_HUMAN_TEXT_MUTATED_PROTECTED_STATE'}
    $sendState=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM messages message JOIN conversations conversation ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id JOIN human_handoffs handoff ON handoff.tenant_id=conversation.tenant_id AND handoff.conversation_id=conversation.id WHERE message.direction='OUTBOUND' AND message.actor='HUMAN' AND message.delivery_status='QUEUED' AND conversation.version=3 AND handoff.first_human_response_at IS NOT NULL; SELECT count(*) FROM outbox_events WHERE event_type='channel.outbound.requested' AND status='PENDING'; SELECT count(*) FROM messages WHERE actor='HERMES'; SELECT count(*) FROM outbox_events WHERE event_type~*'hermes'"
    if(@($sendState|Select-Object -First 2|Where-Object{$_-ne'1'}).Count-ne 0-or @($sendState|Select-Object -Skip 2|Where-Object{$_-ne'0'}).Count-ne 0){throw 'LOCAL_OIDC_HUMAN_TEXT_STATE_INVALID'}
    Compose @('run','--rm','local-seed');$beforeCancel=Read-InboxSnapshot;$beforeCancelImmutable=Read-InboxImmutableSnapshot
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','cancelamento local mantém TEXT')
    $afterCancel=Read-InboxSnapshot;if($afterCancel-eq$beforeCancel){throw 'LOCAL_OIDC_HUMAN_TEXT_CANCEL_DID_NOT_MUTATE_EXPECTED_STATE'}
    $afterCancelImmutable=Read-InboxImmutableSnapshot;if($afterCancelImmutable-ne$beforeCancelImmutable){throw 'LOCAL_OIDC_HUMAN_TEXT_CANCEL_MUTATED_PROTECTED_STATE'}
    $cancelState=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM messages message JOIN human_text_message_commands command ON command.tenant_id=message.tenant_id AND command.message_id=message.id JOIN outbox_events event ON event.tenant_id=command.tenant_id AND event.id=command.outbox_id JOIN conversations conversation ON conversation.tenant_id=message.tenant_id AND conversation.id=message.conversation_id WHERE message.delivery_status='CANCELLED' AND event.status='CANCELLED' AND event.cancelled_at IS NOT NULL AND event.attempts=0 AND event.lease_token IS NULL AND event.published_at IS NULL AND conversation.version=4; SELECT count(*) FROM human_text_message_cancel_commands; SELECT count(*) FROM audit_events WHERE action='HUMAN_TEXT_MESSAGE_CANCELLED'; SELECT count(*) FROM messages WHERE actor='HERMES'; SELECT count(*) FROM outbox_events WHERE event_type~*'hermes'"
    if(@($cancelState|Select-Object -First 3|Where-Object{$_-ne'1'}).Count-ne 0-or @($cancelState|Select-Object -Skip 3|Where-Object{$_-ne'0'}).Count-ne 0){throw 'LOCAL_OIDC_HUMAN_TEXT_CANCEL_STATE_INVALID'}
    Compose @('run','--rm','local-seed');$beforeResolve=Read-InboxSnapshot
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','atendente encerra o próprio atendimento')
    $afterResolve=Read-InboxSnapshot;if($afterResolve-eq$beforeResolve){throw 'LOCAL_OIDC_HANDOFF_RESOLVE_DID_NOT_MUTATE_EXPECTED_STATE'}
    $beforeHistory=Read-InboxSnapshot;Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','gestor consulta atendimento encerrado');$afterHistory=Read-InboxSnapshot
    if($afterHistory-ne$beforeHistory){throw 'LOCAL_OIDC_HANDOFF_HISTORY_MUTATED_STATE'}
    $resolveState=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM human_handoffs handoff JOIN service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id JOIN conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id WHERE handoff.id='90000000-0000-4000-8000-000000000060' AND handoff.status='RESOLVED' AND handoff.version=3 AND handoff.resolved_at IS NOT NULL AND service_case.status='RESOLVED' AND service_case.version=3 AND service_case.resolved_at IS NOT NULL AND conversation.status='CLOSED' AND conversation.automation_status='SUSPENDED' AND conversation.assigned_user_id IS NULL AND conversation.version=3 AND conversation.closed_at IS NOT NULL; SELECT count(*) FROM handoff_resolve_commands WHERE handoff_id='90000000-0000-4000-8000-000000000060' AND disposition='RESOLVED'; SELECT count(*) FROM audit_events WHERE action='HANDOFF_RESOLVED' AND entity_id='90000000-0000-4000-8000-000000000060' AND metadata->>'disposition'='RESOLVED'; SELECT count(*) FROM outbox_events WHERE aggregate_id='90000000-0000-4000-8000-000000000060' AND event_type='handoff.resolved' AND payload->>'disposition'='RESOLVED'; SELECT count(*) FROM messages WHERE direction='OUTBOUND' OR actor='HERMES'; SELECT count(*) FROM outbox_events WHERE event_type~*'(send|hermes)'"
    if(@($resolveState|Select-Object -First 4|Where-Object{$_-ne'1'}).Count-ne 0-or @($resolveState|Select-Object -Skip 4|Where-Object{$_-ne'0'}).Count-ne 0){throw 'LOCAL_OIDC_HANDOFF_RESOLVE_STATE_INVALID'}
    $beforeReopen=Read-InboxSnapshot
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','gestor reabre atendimento encerrado uma única vez')
    $afterReopen=Read-InboxSnapshot;if($afterReopen-eq$beforeReopen){throw 'LOCAL_OIDC_HANDOFF_REOPEN_DID_NOT_MUTATE_EXPECTED_STATE'}
    $reopenState=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM handoff_reopen_commands command JOIN human_handoffs source ON source.tenant_id=command.tenant_id AND source.id=command.source_handoff_id JOIN human_handoffs created ON created.tenant_id=command.tenant_id AND created.id=command.result_handoff_id JOIN service_cases service_case ON service_case.tenant_id=command.tenant_id AND service_case.id=command.service_case_id JOIN conversations conversation ON conversation.tenant_id=command.tenant_id AND conversation.id=command.conversation_id WHERE command.source_handoff_id='90000000-0000-4000-8000-000000000060' AND command.reason='FOLLOW_UP_REQUIRED' AND command.expected_version=3 AND source.status='RESOLVED' AND source.version=3 AND source.resolved_at IS NOT NULL AND created.status='QUEUED' AND created.version=1 AND created.assigned_user_id IS NULL AND created.resolved_at IS NULL AND created.queued_at IS NOT NULL AND service_case.status='WAITING_HUMAN' AND service_case.version=4 AND service_case.resolved_at IS NULL AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_QUEUED' AND conversation.assigned_user_id IS NULL AND conversation.closed_at IS NULL AND conversation.version=4; SELECT count(*) FROM handoff_reopen_commands WHERE source_handoff_id='90000000-0000-4000-8000-000000000060' AND reason='FOLLOW_UP_REQUIRED'; SELECT count(*) FROM audit_events audit JOIN handoff_reopen_commands command ON command.result_handoff_id::text=audit.entity_id WHERE command.source_handoff_id='90000000-0000-4000-8000-000000000060' AND audit.action='HANDOFF_REOPENED' AND audit.metadata->>'sourceHandoffId'=command.source_handoff_id::text; SELECT count(*) FROM outbox_events event JOIN handoff_reopen_commands command ON command.result_handoff_id=event.aggregate_id WHERE command.source_handoff_id='90000000-0000-4000-8000-000000000060' AND event.event_type='handoff.reopened' AND event.payload->>'sourceHandoffId'=command.source_handoff_id::text AND event.payload->>'reason'='FOLLOW_UP_REQUIRED'; SELECT count(*) FROM workflow_transitions transition JOIN handoff_reopen_commands command ON command.tenant_id=transition.tenant_id WHERE command.source_handoff_id='90000000-0000-4000-8000-000000000060' AND transition.reason='MANAGER_REOPENED' AND transition.aggregate_id IN(command.result_handoff_id,command.service_case_id,command.conversation_id); SELECT count(*) FROM messages WHERE direction='OUTBOUND' OR actor='HERMES'; SELECT count(*) FROM outbox_events WHERE event_type~*'(send|outbound|hermes|meta)'"
    if(@($reopenState|Select-Object -First 4|Where-Object{$_-ne'1'}).Count-ne 0-or @($reopenState|Select-Object -Skip 4 -First 1|Where-Object{$_-ne'3'}).Count-ne 0-or @($reopenState|Select-Object -Skip 5|Where-Object{$_-ne'0'}).Count-ne 0){throw 'LOCAL_OIDC_HANDOFF_REOPEN_STATE_INVALID'}
    Compose @('run','--rm','local-seed')
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','transfere atendimento entre dois atendentes')
    $transferState=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM human_handoffs handoff JOIN conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id WHERE handoff.id='90000000-0000-4000-8000-000000000060' AND handoff.status='ACTIVE' AND handoff.assigned_user_id='90000000-0000-4000-8000-000000000012' AND conversation.automation_status='HUMAN_ACTIVE' AND conversation.assigned_user_id='90000000-0000-4000-8000-000000000012'; SELECT count(*) FROM handoff_transfer_commands WHERE handoff_id='90000000-0000-4000-8000-000000000060' AND reason='SHIFT_CHANGE'; SELECT count(*) FROM outbox_events WHERE aggregate_id='90000000-0000-4000-8000-000000000060' AND event_type='handoff.transferred' AND payload->>'reason'='SHIFT_CHANGE'; SELECT count(*) FROM messages WHERE actor='HERMES'; SELECT count(*) FROM outbox_events WHERE event_type~*'hermes'"
    if(@($transferState|Select-Object -First 3|Where-Object{$_-ne'1'}).Count-ne 0-or @($transferState|Select-Object -Skip 3|Where-Object{$_-ne'0'}).Count-ne 0){throw 'LOCAL_OIDC_HANDOFF_TRANSFER_STATE_INVALID'}
    Compose @('run','--rm','local-seed')
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','gestor transfere e reconcilia supervisão')
    $supervisedTransferState=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM human_handoffs handoff JOIN conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id WHERE handoff.id='90000000-0000-4000-8000-000000000060' AND handoff.status='ACTIVE' AND handoff.assigned_user_id='90000000-0000-4000-8000-000000000011' AND conversation.automation_status='HUMAN_ACTIVE' AND conversation.assigned_user_id='90000000-0000-4000-8000-000000000011'; SELECT count(*) FROM handoff_transfer_commands WHERE handoff_id='90000000-0000-4000-8000-000000000060' AND actor_id='90000000-0000-4000-8000-000000000012' AND target_user_id='90000000-0000-4000-8000-000000000011' AND reason='LOAD_BALANCING'; SELECT count(*) FROM outbox_events WHERE aggregate_id='90000000-0000-4000-8000-000000000060' AND event_type='handoff.transferred' AND payload->>'reason'='LOAD_BALANCING'; SELECT count(*) FROM messages WHERE actor='HERMES'; SELECT count(*) FROM outbox_events WHERE event_type~*'(send|hermes|meta)'"
    if(@($supervisedTransferState|Select-Object -First 3|Where-Object{$_-ne'1'}).Count-ne 0-or @($supervisedTransferState|Select-Object -Skip 3|Where-Object{$_-ne'0'}).Count-ne 0){throw 'LOCAL_OIDC_SUPERVISED_TRANSFER_STATE_INVALID'}
    Compose @('run','--rm','local-seed')
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','gestor assume atendimento supervisionado')
    $takeoverState=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM human_handoffs handoff JOIN service_cases service_case ON service_case.tenant_id=handoff.tenant_id AND service_case.id=handoff.service_case_id JOIN conversations conversation ON conversation.tenant_id=handoff.tenant_id AND conversation.id=handoff.conversation_id WHERE handoff.id='90000000-0000-4000-8000-000000000060' AND handoff.status='ACTIVE' AND handoff.assigned_user_id='90000000-0000-4000-8000-000000000012' AND handoff.version=3 AND service_case.status='IN_REVIEW' AND service_case.version=2 AND conversation.status='OPEN' AND conversation.automation_status='HUMAN_ACTIVE' AND conversation.assigned_user_id='90000000-0000-4000-8000-000000000012' AND conversation.version=3; SELECT count(*) FROM handoff_takeover_commands WHERE handoff_id='90000000-0000-4000-8000-000000000060' AND actor_id='90000000-0000-4000-8000-000000000012' AND previous_assigned_user_id='90000000-0000-4000-8000-000000000011'; SELECT count(*) FROM audit_events WHERE action='HANDOFF_TAKEN_OVER' AND entity_id='90000000-0000-4000-8000-000000000060'; SELECT count(*) FROM outbox_events WHERE aggregate_id='90000000-0000-4000-8000-000000000060' AND event_type='handoff.taken_over'; SELECT count(*) FROM workflow_transitions WHERE reason='SUPERVISOR_TAKEOVER' AND aggregate_id IN('90000000-0000-4000-8000-000000000060',(SELECT conversation_id FROM human_handoffs WHERE id='90000000-0000-4000-8000-000000000060')); SELECT count(*) FROM messages WHERE direction='OUTBOUND' OR actor='HERMES'; SELECT count(*) FROM outbox_events WHERE event_type~*'(send|outbound|hermes|meta)'"
    if(@($takeoverState|Select-Object -First 4|Where-Object{$_-ne'1'}).Count-ne 0-or @($takeoverState|Select-Object -Skip 4 -First 1|Where-Object{$_-ne'2'}).Count-ne 0-or @($takeoverState|Select-Object -Skip 5|Where-Object{$_-ne'0'}).Count-ne 0){throw 'LOCAL_OIDC_HANDOFF_TAKEOVER_STATE_INVALID'}
    Compose @('run','--rm','-e','LOCAL_SEED_META_STATUS=true','local-seed')
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','reconciliação sintética local')
    $statusState=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM messages WHERE id='90000000-0000-4000-8000-000000000070' AND direction='OUTBOUND' AND actor='HUMAN' AND external_message_id='wamid.local.synthetic.status.001' AND delivery_status='READ' AND provider_sent_at='2026-08-10T12:05:00Z' AND extract(epoch FROM provider_delivered_at)=1786382700 AND extract(epoch FROM provider_read_at)=1786382760 AND provider_failed_at IS NULL AND extract(epoch FROM last_provider_status_at)=1786382760; SELECT count(*) FROM meta_delivery_status_receipts WHERE external_message_id='wamid.local.synthetic.status.001'; SELECT count(*) FROM meta_delivery_status_applications WHERE outcome='APPLIED' AND receipt_id IN(SELECT id FROM meta_delivery_status_receipts WHERE external_message_id='wamid.local.synthetic.status.001'); SELECT count(*) FROM meta_delivery_status_applications WHERE outcome='IGNORED_STALE' AND receipt_id IN(SELECT id FROM meta_delivery_status_receipts WHERE external_message_id='wamid.local.synthetic.status.001'); SELECT count(*) FROM audit_events WHERE action='META_DELIVERY_STATUS_RECONCILED' AND entity_id IN(SELECT id::text FROM meta_delivery_status_receipts WHERE external_message_id='wamid.local.synthetic.status.001'); SELECT count(*) FROM messages WHERE actor='HERMES'; SELECT count(*) FROM outbox_events WHERE event_type~*'(send|hermes)'"
    if(@($statusState|Select-Object -First 1|Where-Object{$_-ne'1'}).Count-ne 0-or@($statusState|Select-Object -Skip 1 -First 1|Where-Object{$_-ne'3'}).Count-ne 0-or
      @($statusState|Select-Object -Skip 2 -First 1|Where-Object{$_-ne'2'}).Count-ne 0-or@($statusState|Select-Object -Skip 3 -First 1|Where-Object{$_-ne'1'}).Count-ne 0-or
      @($statusState|Select-Object -Skip 4 -First 1|Where-Object{$_-ne'3'}).Count-ne 0-or@($statusState|Select-Object -Skip 5|Where-Object{$_-ne'0'}).Count-ne 0){throw 'LOCAL_OIDC_META_STATUS_STATE_INVALID'}
    Compose @('run','--rm','local-seed')
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','gestor administra vínculos da unidade')
    Compose @('run','--rm','local-seed')
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep','admin encaminha entrada sem unidade')
    $routingState=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM inbound_channel_events event WHERE event.tenant_id='90000000-0000-4000-8000-000000000001' AND event.idempotency_key='META_WHATSAPP:wamid.local.e2e.routing.001:local-e2e-routing-account' AND event.routing_status='ROUTED' AND event.routing_reason IS NULL AND event.unit_id='90000000-0000-4000-8000-000000000002'; SELECT count(*) FROM outbox_events outbox JOIN inbound_channel_events event ON event.tenant_id=outbox.tenant_id AND event.id=outbox.aggregate_id WHERE event.idempotency_key='META_WHATSAPP:wamid.local.e2e.routing.001:local-e2e-routing-account' AND outbox.event_type='channel.inbound.received' AND outbox.status='PENDING'; SELECT count(*) FROM messages WHERE direction='OUTBOUND' OR actor='HERMES'; SELECT count(*) FROM outbox_events WHERE event_type~*'(send|hermes|meta)'"
    if(@($routingState|Select-Object -First 2|Where-Object{$_-ne'1'}).Count-ne 0-or @($routingState|Select-Object -Skip 2|Where-Object{$_-ne'0'}).Count-ne 0){throw 'LOCAL_OIDC_INBOUND_ROUTING_STATE_INVALID'}
    Compose @('run','--rm','local-seed')
    Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc','--grep-invert','(inbound materializado|resposta humana TEXT|cancelamento local mantém TEXT|atendente encerra o próprio atendimento|gestor consulta atendimento encerrado|gestor reabre atendimento encerrado uma única vez|transfere atendimento entre dois atendentes|gestor transfere e reconcilia supervisão|gestor assume atendimento supervisionado|reconciliação sintética local|gestor administra vínculos da unidade|admin encaminha entrada sem unidade)')
    $active=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM users WHERE email IN ('admin.local@example.test','attendant.local@example.test','attendant.two.local@example.test') AND status='ACTIVE'";if(($active|Out-String).Trim()-ne'3'){throw 'LOCAL_OIDC_SYNTHETIC_ACCOUNTS_NOT_ACTIVE'}
    $activeMemberships=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM user_units membership JOIN users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id WHERE account.email IN ('admin.local@example.test','attendant.local@example.test','attendant.two.local@example.test') AND membership.status='ACTIVE'";if(($activeMemberships|Out-String).Trim()-ne'3'){throw 'LOCAL_OIDC_SYNTHETIC_MEMBERSHIPS_NOT_ACTIVE'}
    $managerMembership=& docker compose --project-name $projectName --env-file $envFile @composeFiles exec -T postgres psql -U zap_pronto_owner -d zap_pronto -Atc "SELECT count(*) FROM user_units membership JOIN users account ON account.tenant_id=membership.tenant_id AND account.id=membership.user_id WHERE account.id='90000000-0000-4000-8000-000000000012' AND account.email='attendant.two.local@example.test' AND account.status='ACTIVE' AND membership.status='ACTIVE' AND membership.role='UNIT_MANAGER'";if(($managerMembership|Out-String).Trim()-ne'1'){throw 'LOCAL_OIDC_SYNTHETIC_MANAGER_MEMBERSHIP_INVALID'}
  }finally{Compose @('run','--rm','local-seed');foreach($key in $vars.Keys){Remove-Item "Env:$key" -ErrorAction SilentlyContinue}}
}
function Untrust {
  if(-not(Test-Path -LiteralPath $markerFile -PathType Leaf)){throw 'LOCAL_CA_MARKER_REQUIRED'}
  $marker=Get-Content -Raw -LiteralPath $markerFile|ConvertFrom-Json
  if((Get-FileHash -Algorithm SHA256 -LiteralPath $marker.certificate).Hash-ne$marker.sha256){throw 'LOCAL_CA_SOURCE_CHANGED'}
  $source=[Security.Cryptography.X509Certificates.X509Certificate2]::new($marker.certificate)
  if($source.Thumbprint-ne$marker.thumbprint){throw 'LOCAL_CA_MARKER_MISMATCH'}
  $target="Cert:\CurrentUser\Root\$($marker.thumbprint)";$installed=@(Get-Item -LiteralPath $target -ErrorAction SilentlyContinue)
  if($installed.Count-ne 1-or [Convert]::ToBase64String($installed[0].RawData)-ne [Convert]::ToBase64String($source.RawData)){throw 'LOCAL_CA_INSTALLED_CERTIFICATE_MISMATCH'}
  Remove-Item -LiteralPath $target;if(Test-Path -LiteralPath $target){throw 'LOCAL_CA_REMOVE_FAILED'};Remove-Item -LiteralPath $markerFile
  'local OIDC CA untrusted'
}
Set-Location $repoRoot
switch($Action){'Setup'{Setup}'Up'{Up}'Verify'{Verify}'E2E'{E2E}'Down'{Assert-HarnessMarker;Assert-ProjectResources;Compose @('down')}'Destroy'{Assert-HarnessMarker;Assert-ProjectResources;Compose @('down','--volumes')}'Untrust'{Untrust}}
