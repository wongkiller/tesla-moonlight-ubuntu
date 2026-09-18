param([string]$Name = 'sunshine-01', [int]$LocalPort = 43880, [switch]$RepairSandbox)
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]+$') { throw 'Invalid Docker container name' }
& docker inspect $Name *> $null
$exists = $LASTEXITCODE -eq 0
$image = 'ubuntu:26.04'
$backup = $null
if ($exists) {
  if (-not $RepairSandbox) { throw "Container $Name already exists. Use docker start $Name; no data was changed." }
  # Preserve the complete container layer and state volumes for early installs.
  # This image is local only: never push a migration snapshot with private config.
  $backup = "$Name-before-sandbox-$(Get-Date -Format yyyyMMddHHmmss)"
  $image = "local/$Name-sandbox-migration:$(Get-Date -Format yyyyMMddHHmmss)"
  & docker stop $Name
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop original container' }
  & docker commit $Name $image
  if ($LASTEXITCODE -ne 0) { & docker start $Name; throw 'Snapshot failed; original restarted' }
  & docker rename $Name $backup
  if ($LASTEXITCODE -ne 0) { throw 'Could not retain original container' }
}
$seccomp = Join-Path (Split-Path $PSScriptRoot -Parent) 'config/docker/chrome-seccomp.json'
$command = @'
set -eu
if [ ! -d /opt/tesla-moonlight-ubuntu/.git ]; then
  apt-get -o Acquire::Retries=3 update
  DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y git ca-certificates
  git clone https://github.com/wongkiller/tesla-moonlight-ubuntu.git /opt/tesla-moonlight-ubuntu
fi
exec bash /opt/tesla-moonlight-ubuntu/scripts/container-entrypoint.sh
'@
& docker run -d --name $Name --hostname $Name --init --restart unless-stopped --shm-size 1g `
  --security-opt "seccomp=$seccomp" `
  --mount "type=volume,source=$Name-config,target=/root/.config/tesla-moonlight-ubuntu" `
  --mount "type=volume,source=$Name-data,target=/home/sunshine" `
  -p "127.0.0.1:${LocalPort}:8080" $image bash -lc $command
if ($LASTEXITCODE -ne 0) { throw 'Docker creation failed' }
Write-Host "Created $Name. Follow startup: docker logs -f $Name"
Write-Host 'Fill /opt/tesla-moonlight-ubuntu/config/internet.json inside the container; installation then continues automatically.'
Write-Host "Local page after installation: http://localhost:$LocalPort"
if ($backup) { Write-Host "Rollback container retained: $backup. Snapshot is LOCAL ONLY and can contain private settings." }
