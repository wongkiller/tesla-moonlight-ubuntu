# CasaOS / Linux Docker setup (no volumes)

This example creates a clean Ubuntu 26.04 container, installs Git inside it,
clones this repository, and runs the unattended installer. It matches the
`sunshine-02` CasaOS deployment and deliberately defines **no Docker volumes**.

## Deploy

On the CasaOS host, clone the repository and start the supplied Compose file:

```bash
git clone https://github.com/wongkiller/tesla-moonlight-ubuntu.git
cd tesla-moonlight-ubuntu
docker compose -f docker-compose.casaos.yml up -d
docker logs -f sunshine-02
```

The defaults are container `sunshine-02` and host port `43880`. Override them
without editing the file:

```bash
SUNSHINE_CONTAINER_NAME=sunshine-03 SUNSHINE_WEB_PORT=43881 \
docker compose -f docker-compose.casaos.yml up -d
```

The supplied Compose file sets `shm_size: 1gb`. CasaOS custom-app compose
often drops that field, so the container entrypoint remounts `/dev/shm` to
1 GiB at start. Chrome always uses `/dev/shm` — do not add
`--disable-dev-shm-usage` (that path goes through `/tmp` overlay and lags
audio/video).

In CasaOS or Portainer, the same file can be pasted into the Compose/Stack web
editor. Keep **Privileged mode disabled** and do not add a volume if you want the
same disposable-container layout.

The CasaOS example uses `seccomp=unconfined` because the CasaOS custom-app form
does not accept a custom seccomp profile. It is scoped to this container and is
needed for Chrome's user-namespace sandbox. On a normal Linux Docker host, the
more restrictive profile documented in [DOCKER.md](DOCKER.md#browser-sandbox)
is preferred.

## Supply the private config

Create `internet.json` on the Docker host from
`config/internet.example.json`, then copy it into the cloned repository inside
the running container. The file is not printed by these commands.

Linux shell:

```bash
docker exec -i sunshine-02 sh -c \
  'umask 077; cat > /opt/tesla-moonlight-ubuntu/config/internet.json' \
  < internet.json
```

PowerShell:

```powershell
Get-Content -Raw .\internet.json |
  docker exec -i sunshine-02 sh -c "umask 077; cat > /opt/tesla-moonlight-ubuntu/config/internet.json"
```

The startup process checks the file every 15 seconds. A valid file continues
installation automatically; no restart is needed while it displays
`WAITING FOR CONFIG`.

## Start, stop, restart, update

```bash
docker stop sunshine-02
docker start sunshine-02
docker restart sunshine-02
docker logs --tail 100 -f sunshine-02
docker exec sunshine-02 git -C /opt/tesla-moonlight-ubuntu pull --ff-only
docker restart sunshine-02
```

Every start enters `install.sh --auto`. The process checks that dependencies and
the pinned runtime already exist, validates the config, reapplies generated
configuration idempotently, and then starts Supervisor. Installed packages are
not downloaded again when already present. The Compose command also skips
`apt-get update` after Git has been installed.

Because this layout has no volume, ordinary `docker stop`, `docker start`, and
`docker restart` preserve the repository, config, installed packages, Chrome
profile, and Sunshine pairing in the container writable layer. Removing or
recreating the container deletes all of them. Copy the private config in again
after `docker compose down`, a forced recreate, or a change that replaces the
container.

## Status and logs

```bash
docker ps --filter name=sunshine-02
docker exec sunshine-02 supervisorctl -c /etc/tesla-moonlight-ubuntu/supervisord.conf status
docker exec sunshine-02 tail -n 100 /var/log/tesla-moonlight-ubuntu/install.log
docker exec sunshine-02 tail -n 100 /home/sunshine/.local/share/tesla-moonlight-ubuntu/logs/ready.log
docker exec sunshine-02 cat /home/sunshine/.local/share/tesla-moonlight-ubuntu/server/health-status.json
```

`READY` in the logs confirms that the configured public hostname reaches this
specific installation. A Cloudflare HTTP 530 means the hostname route exists
but Cloudflare cannot currently reach the Tunnel connector.
