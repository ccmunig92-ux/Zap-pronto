[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('Setup','Up','Verify','E2E','Down','Destroy','Untrust')][string]$Action)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'ZapPronto\local-oidc-runtime'
$tlsRoot = Join-Path $env:LOCALAPPDATA 'ZapPronto\local-oidc-tls'
$envFile = Join-Path $runtimeRoot 'local.env'
$markerFile = Join-Path $tlsRoot 'trust-marker.json'
$hostname = 'zap-pronto.127.0.0.1.nip.io'
$origin = 'https://' + $hostname + ':18443'
$projectName = 'zap-pronto-local-oidc'
$composeFiles = @('-f',(Join-Path $repoRoot 'deploy\staging\compose.yaml'),'-f',(Join-Path $repoRoot 'deploy\local-oidc\compose.yaml'))

function Invoke-Checked([string]$Command,[string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "COMMAND_FAILED:$Command" }
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
function Compose([string[]]$Arguments) {
  Invoke-Checked 'docker' (@('compose','--project-name',$projectName,'--env-file',$envFile)+$composeFiles+$Arguments)
}
function Setup {
  Assert-ExternalRoot $runtimeRoot; Assert-ExternalRoot $tlsRoot
  New-Item -ItemType Directory -Force -Path $runtimeRoot,$tlsRoot|Out-Null
  Invoke-Checked 'icacls' @($runtimeRoot,'/inheritance:r','/grant:r',"$($env:USERNAME):(OI)(CI)F")
  Invoke-Checked 'icacls' @($tlsRoot,'/inheritance:r','/grant:r',"$($env:USERNAME):(OI)(CI)F")
  $openssl='C:\Program Files\Git\usr\bin\openssl.exe'
  if(-not(Test-Path -LiteralPath $openssl -PathType Leaf)){throw 'OPENSSL_REQUIRED'}
  $ca=Join-Path $tlsRoot 'ca.crt'; $caKey=Join-Path $tlsRoot 'ca.key'
  $cert=Join-Path $tlsRoot 'tls.crt'; $key=Join-Path $tlsRoot 'tls.key'
  if(-not(Test-Path -LiteralPath $cert)){
    Invoke-Checked $openssl @('req','-x509','-newkey','rsa:3072','-sha256','-nodes','-keyout',$caKey,'-out',$ca,'-subj','/CN=Zap Pronto Local Development CA','-days','30')
    $csr=Join-Path $tlsRoot 'tls.csr'
    Invoke-Checked $openssl @('req','-newkey','rsa:3072','-sha256','-nodes','-keyout',$key,'-out',$csr,'-subj',"/CN=$hostname",'-addext',"subjectAltName=DNS:$hostname")
    Invoke-Checked $openssl @('x509','-req','-in',$csr,'-CA',$ca,'-CAkey',$caKey,'-CAcreateserial','-out',$cert,'-days','30','-sha256','-copy_extensions','copy')
    Remove-Item -LiteralPath $csr -Force
  }
  $source=[Security.Cryptography.X509Certificates.X509Certificate2]::new($ca)
  $store=[Security.Cryptography.X509Certificates.X509Store]::new('Root',[Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
  try{$store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite);if(@($store.Certificates|Where-Object Thumbprint -eq $source.Thumbprint).Count-eq 0){$store.Add($source)}}finally{$store.Close()}
  $trusted=@(Get-ChildItem Cert:\CurrentUser\Root|Where-Object Thumbprint -eq $source.Thumbprint)
  if($trusted.Count-ne 1-or $trusted[0].HasPrivateKey-or [Convert]::ToBase64String($trusted[0].RawData)-ne [Convert]::ToBase64String($source.RawData)){throw 'LOCAL_CA_TRUST_VERIFICATION_FAILED'}
  @{thumbprint=$source.Thumbprint;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $ca).Hash;certificate=$ca}|ConvertTo-Json|Set-Content -LiteralPath $markerFile -Encoding utf8
  if(-not(Test-Path -LiteralPath $envFile)){
    $pg=New-RandomSecret;$runtime=New-RandomSecret;$admin=New-RandomSecret;$attendant=New-RandomSecret
    Set-Content -LiteralPath (Join-Path $runtimeRoot 'postgres-password') -NoNewline -Value $pg
    Set-Content -LiteralPath (Join-Path $runtimeRoot 'database-migration-url') -NoNewline -Value "postgresql://zap_pronto_owner:$pg@postgres:5432/zap_pronto"
    Set-Content -LiteralPath (Join-Path $runtimeRoot 'database-runtime-url') -NoNewline -Value "postgresql://zap_pronto_runtime:$runtime@postgres:5432/zap_pronto"
    @('ZAP_API_IMAGE=zap-pronto-api:local','ZAP_WEB_IMAGE=zap-pronto-web:local','POSTGRES_IMAGE=postgres:18.3-alpine@sha256:54451ecb8ab38c24c3ec123f2fd501303a3a1856a5c66e98cecf2460d5e1e9d7','POSTGRES_DB=zap_pronto','POSTGRES_USER=zap_pronto_owner',
      "POSTGRES_PASSWORD_FILE=$((Join-Path $runtimeRoot 'postgres-password').Replace('\','/'))",
      "DATABASE_MIGRATION_URL_FILE=$((Join-Path $runtimeRoot 'database-migration-url').Replace('\','/'))",
      "DATABASE_RUNTIME_URL_FILE=$((Join-Path $runtimeRoot 'database-runtime-url').Replace('\','/'))",
      "LOCAL_OIDC_HOST=$hostname",'LOCAL_HTTPS_PORT=18443',"LOCAL_OIDC_ORIGIN=$origin",'LOCAL_KEYCLOAK_ADMIN_USERNAME=local-admin',
      "LOCAL_KEYCLOAK_ADMIN_PASSWORD=$(New-RandomSecret)","LOCAL_OIDC_ADMIN_PASSWORD=$admin", "LOCAL_OIDC_ATTENDANT_PASSWORD=$attendant",
      "LOCAL_TLS_CA_FILE=$($ca.Replace('\','/'))","LOCAL_TLS_CERT_FILE=$($cert.Replace('\','/'))","LOCAL_TLS_KEY_FILE=$($key.Replace('\','/'))",
      "OIDC_ISSUER=$origin/realms/zap-pronto-local","OIDC_AUTHORITY_ORIGIN=$origin",'OIDC_AUDIENCE=zap-pronto-local',
      "OIDC_JWKS_URL=$origin/realms/zap-pronto-local/protocol/openid-connect/certs",
      "OIDC_DISCOVERY_URL=$origin/realms/zap-pronto-local/.well-known/openid-configuration",'OIDC_ORGANIZATION_CLAIM=org_id')|Set-Content -LiteralPath $envFile -Encoding utf8
  }
  'local OIDC setup ready'
}
function Verify {
  $null=Read-LocalEnvironment;Compose @('config','--quiet')
  $discovery=Invoke-RestMethod -Uri "$origin/realms/zap-pronto-local/.well-known/openid-configuration"
  if($discovery.issuer-ne"$origin/realms/zap-pronto-local"-or-not @($discovery.code_challenge_methods_supported).Contains('S256')){throw 'LOCAL_OIDC_DISCOVERY_INVALID'}
  $jwks=Invoke-RestMethod -Uri $discovery.jwks_uri;if(@($jwks.keys).Count-lt 1){throw 'LOCAL_OIDC_JWKS_INVALID'}
  $live=Invoke-RestMethod -Uri "$origin/health/live";if($live.status-ne'ok'){throw 'LOCAL_OIDC_API_UNHEALTHY'}
  'local OIDC verify passed'
}
function Up {
  $null=Read-LocalEnvironment
  Invoke-Checked 'docker' @('build','-f','Dockerfile.api','-t','zap-pronto-api:local','.')
  Invoke-Checked 'docker' @('build','-f','Dockerfile.web','-t','zap-pronto-web:local','--build-arg',"VITE_OIDC_AUTHORITY=$origin/realms/zap-pronto-local",'--build-arg','VITE_OIDC_CLIENT_ID=zap-pronto-local','--build-arg',"VITE_OIDC_REDIRECT_URI=$origin/",'--build-arg',"VITE_OIDC_POST_LOGOUT_REDIRECT_URI=$origin/",'--build-arg','VITE_OIDC_SCOPE=openid profile email','--build-arg','VITE_OIDC_AUTOMATIC_SILENT_RENEW=true','.')
  Compose @('up','-d','--remove-orphans','--wait');Verify
}
function E2E {
  $v=Read-LocalEnvironment
  $vars=@{E2E_OIDC_ENABLED='true';E2E_BASE_URL=$origin;E2E_REQUIRE_RENEWAL='true';E2E_REQUIRE_BLOCK_REVOCATION='true';E2E_RENEW_WAIT_SECONDS='45';E2E_OIDC_TEST_TIMEOUT_MS='240000';E2E_OIDC_USERNAME_SELECTOR='#username';E2E_OIDC_PASSWORD_SELECTOR='#password';E2E_OIDC_SUBMIT_SELECTOR='#kc-login';E2E_ADMIN_USERNAME='admin.local';E2E_ADMIN_PASSWORD=$v.LOCAL_OIDC_ADMIN_PASSWORD;E2E_ADMIN_EXPECTED_TENANT='Clínica Local';E2E_ATTENDANT_USERNAME='attendant.local';E2E_ATTENDANT_PASSWORD=$v.LOCAL_OIDC_ATTENDANT_PASSWORD;E2E_ATTENDANT_EXPECTED_TENANT='Clínica Local';E2E_ATTENDANT_ADMIN_LIST_MATCH='attendant.local@example.test'}
  foreach($entry in $vars.GetEnumerator()){Set-Item "Env:$($entry.Key)" $entry.Value}
  Invoke-Checked 'pnpm' @('--filter','@zap-pronto/web','test:e2e:oidc')
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
switch($Action){'Setup'{Setup}'Up'{Up}'Verify'{Verify}'E2E'{E2E}'Down'{Compose @('down')}'Destroy'{Compose @('down','--volumes')}'Untrust'{Untrust}}
