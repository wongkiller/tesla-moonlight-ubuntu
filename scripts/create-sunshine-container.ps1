param([string]$Name = 'sunshine-01', [int]$LocalPort = 43880)
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]+$') { throw 'Invalid Docker container name' }
& docker inspect $Name *> $null
if ($LASTEXITCODE -eq 0) { throw "Container $Name already exists. Use docker start $Name; no data was changed." }
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
  --mount "type=volume,source=$Name-config,target=/root/.config/tesla-moonlight-ubuntu" `
  --mount "type=volume,source=$Name-data,target=/home/sunshine" `
  -p "127.0.0.1:${LocalPort}:8080" ubuntu:26.04 bash -lc $command
if ($LASTEXITCODE -ne 0) { throw 'Docker creation failed' }
Write-Host "Created $Name. Follow startup: docker logs -f $Name"
Write-Host 'Fill /root/.config/tesla-moonlight-ubuntu/internet.json inside the container; installation then continues automatically.'
Write-Host "Local page after installation: http://localhost:$LocalPort"
