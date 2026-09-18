# Ubuntu Docker installation

## Fill one private file

Your clone's **config/internet.json** is the user-editable configuration. It is
created automatically and ignored by Git. Never put credentials in
`internet.example.json`, issues, commits or screenshots.

| Field | Required for public access | Purpose |
|---|---|---|
| public_hostname | Yes | DNS hostname only, without https:// |
| web_password | Yes | Unique password, at least 16 characters |
| cloudflare_tunnel_token | Yes | Connector token from the Cloudflare Tunnel |
| cloudflare_turn_token_id | Yes | Cloudflare Realtime TURN token ID |
| cloudflare_turn_api_token | Yes | TURN credential-generation API token |
| cloudflare_api_token | For automatic route creation | Account Cloudflare Tunnel Edit and Zone DNS Edit, restricted to your account/zone |
| cloudflare_zone_id | With the API token above | ID of the domain's Cloudflare zone |

To test locally first, leave hostname and all Cloudflare fields empty and fill
only web_password. Internet media needs TURN. The optional Cloudflare management
API token is different from both the connector token and the TURN API token.
Only the root installer reads it; it is not copied to the desktop service user.

Without a management API token, configure the hostname route beforehand to
**http://localhost:8080** in that Tunnel. A connector token cannot create DNS.
With the API token and Zone ID, the script preserves other ingress routes and
creates the requested hostname's proxied CNAME. Conflicting DNS records cause a
clear error instead of being overwritten. Avoid reusing a token whose other
connectors still serve a different installation: Cloudflare can distribute
requests between them. Use a separate Tunnel or stop the old connector.

## What happens automatically

1. Check Ubuntu version and container environment, create the private template.
2. Report missing apt packages; install desktop, audio, Node,
   Supervisor, official Sunshine and cloudflared packages, and official Chrome.
3. Download the pinned Ubuntu runtime and check archive/file hashes. No compiler
   or tests are required. Failed commands stop with a log path; rerunning preserves data.
4. Start rootless Xorg dummy, private PulseAudio and D-Bus, XFCE and software
   Sunshine. Generate private Sunshine credentials; preserve existing pairings.
5. Configure YouTube Remote, dynamic Window/Full/Auto modes and web controls.
6. Automatically pair the bridge to Sunshine. Start the Tunnel, if configured.
7. Check that the public hostname reaches this specific container; report a
   route/DNS/old-connector problem if it does not.

All installation commands are in version-controlled scripts. No ChatGPT session,
manual service setup or test workflow is required.

## Logs and recovery

```powershell
docker logs --tail 60 sunshine-01
docker exec sunshine-01 supervisorctl -c /etc/tesla-moonlight-ubuntu/supervisord.conf status
docker exec sunshine-01 tail -n 60 /var/log/tesla-moonlight-ubuntu/install.log
docker exec sunshine-01 tail -n 60 /home/sunshine/.local/share/tesla-moonlight-ubuntu/logs/ready.log
docker exec sunshine-01 cat /home/sunshine/.local/share/tesla-moonlight-ubuntu/server/health-status.json
```

`ready.log` is timestamped and rotated. Readiness remains active: it checks the
local origin, public instance identity and actual Moonlight page every 30 seconds.
It distinguishes DNS, TLS, HTTP route/origin failures and the wrong installation.
The same messages appear in `docker logs`; installed packages or a connected
Tunnel alone are not reported as public readiness. If a new hostname still gives
NXDOMAIN on Windows after the public service is ready, run `Clear-DnsClientCache`
in PowerShell and reload the browser. This does not change your DNS server.

After editing the config on an already running installation, restart the
container to validate and apply it. Update the repository and rerun the same
startup script by restarting (no manual service setup):

```powershell
docker exec sunshine-01 git -C /opt/tesla-moonlight-ubuntu pull --ff-only
docker restart sunshine-01
```

The startup command enters `install.sh --auto` on every container start. This
does not reinstall packages or redownload the pinned runtime when they are
already present: it checks dependencies, validates the config, reapplies the
generated configuration idempotently, and then starts Supervisor. The CasaOS
Compose example also skips its initial `apt-get update` after Git exists.

The default script creates two named volumes: `sunshine-01-data` (desktop,
pairings and Chrome profile) and `sunshine-01-config` (private configuration
backup). A valid config is copied into the private volume. A fresh clone restores
it when config/internet.json is absent. Container restart preserves all files;
container recreation with the same volumes preserves the state above. Back up
the named volumes before deleting them. Dependency packages and compiler cache
live in the container layer and can be reinstalled automatically on recreation.

Do not publish 47990, 9227 or 9228. The provided script publishes only the
authenticated web bridge on Windows loopback port 43880. Tunnel and TURN use
outbound connections. Docker Desktop and the Windows computer must stay running.

For a no-volume CasaOS deployment, see [CASAOS.md](CASAOS.md). Container restart
preserves its writable layer, but removing or recreating that container also
removes its private config and installed state.

## Browser sandbox

The Windows creation script uses `config/docker/chrome-seccomp.json`, the
[official Chromium user-namespace profile](https://playwright.dev/docs/docker)
distributed by Microsoft Playwright. It permits namespace creation for Chrome's
sandbox; the browser still runs as an unprivileged user. The setup does not use
`--privileged`, `SYS_ADMIN`, host IPC or `--no-sandbox`.

When creating an Ubuntu container yourself, use `--init --shm-size=1g` and
`--security-opt seccomp=/absolute/path/to/config/docker/chrome-seccomp.json`.
An ordinary Docker default profile can block Chromium's sandbox namespaces.
This host-side setting cannot be changed from inside the container. Existing
early installations can use `create-sunshine-container.ps1 -RepairSandbox`; it
retains a stopped rollback container and a **private local-only** snapshot image.
Do not publish that snapshot: it can include your private repo config.
