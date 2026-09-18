# Tesla Moonlight Ubuntu

Stream an Ubuntu desktop to a Tesla browser, based on
[wongkiller/tesla-moonlight-mac](https://github.com/wongkiller/tesla-moonlight-mac).
Target: **Ubuntu 26.04**, initially built and tested in Ubuntu 26.04 WSL2 on x86-64.

The source includes the original Tesla canvas video renderer, Opus audio worker,
touch/keyboard controls, H.264 profiles and connection recovery. The Ubuntu port
replaces Homebrew, LaunchAgents and Keychain with native builds, systemd user
services and private configuration files. See [UPSTREAM.md](UPSTREAM.md).

```text
Ubuntu desktop -> Sunshine -> Moonlight Web bridge -> Tesla browser
                                     |                    |
                         Cloudflare Tunnel (HTTPS/signaling)
                         Cloudflare TURN   (WebRTC media)
```

Cloudflare Tunnel publishes the page and signaling; **TURN is separately needed
for media across the internet** in this deployment. Both ends make outbound
connections; this design does not require router port forwarding.

## Install: clone, fill config, run

Inside a clean Ubuntu 26.04 amd64 container, run as root:

```bash
apt-get update && apt-get install -y git ca-certificates
git clone https://github.com/wongkiller/tesla-moonlight-ubuntu.git
cd tesla-moonlight-ubuntu
cp config/internet.example.json config/internet.json
# Fill config/internet.json with your hostname, password and Cloudflare values.
bash install.sh --auto
```

The installer installs the dependencies, downloads the checksum-verified runtime,
configures the desktop, Sunshine and Chrome, pairs the host, and starts services.
It does **not** run tests or require ChatGPT. It stays in the foreground as the
service supervisor. Your private config is gitignored.

For Docker, the container must support Chrome's sandbox namespaces; the creation
script below supplies that setting and persistent volumes automatically. Docker
startup settings cannot be changed from inside an existing container.

## Create the Ubuntu container on Windows

The container edition installs its own X11 desktop, audio, Sunshine, Chrome,
YouTube Remote, web bridge and cloudflared. No manual Sunshine pairing, desktop
configuration or service creation is needed. Services run as the unprivileged
`sunshine` user under Supervisor; Docker does not need systemd or a mounted GPU.

On Windows with Docker Desktop running Linux containers:

```powershell
git clone https://github.com/wongkiller/tesla-moonlight-ubuntu.git
cd tesla-moonlight-ubuntu
.\scripts\create-sunshine-container.ps1
```

This creates **sunshine-01** from official `ubuntu:26.04`, installs Git **inside
the container**, clones this repository there and starts the unattended installer.
Fill **`/opt/tesla-moonlight-ubuntu/config/internet.json`** using Docker Desktop's
Files editor, or:

```powershell
docker exec -it sunshine-01 nano /opt/tesla-moonlight-ubuntu/config/internet.json
docker logs -f sunshine-01
```

The file is created automatically from `config/internet.example.json` and is
**gitignored**. Keep your real tokens out of the example file. Dependencies install
while you fill it; once valid, configuration and service startup continue
automatically. Public access uses the configured hostname. The local page is
`http://localhost:43880` (loopback only); Sunshine admin/debug ports are not
published. Select **Ubuntu 26.04 Docker Desktop → YouTube Remote** or Desktop.

Already inside a fresh Ubuntu 26.04 amd64 container? Install Git if necessary,
clone, and use the same repository entry point as root:

```bash
apt-get update && apt-get install -y git ca-certificates
git clone https://github.com/wongkiller/tesla-moonlight-ubuntu.git
cd tesla-moonlight-ubuntu
# Starts dependency setup, creates config/internet.json, waits for your values,
# configures everything and stays in the foreground as the service supervisor.
bash install.sh --auto
```

Use that entry point as the container's startup command for automatic restart.
The Windows creation script already does this. See [Docker setup and recovery](docs/DOCKER.md)
for config fields, persistent storage and the Cloudflare permissions needed for
automatic DNS/hostname setup. A CPU-rendered Docker desktop is functional but is
not a substitute for native GPU game streaming.

For CasaOS or a Linux Docker host without volumes, use
[`docker-compose.casaos.yml`](docker-compose.casaos.yml) and the
[CasaOS / Linux Docker guide](docs/CASAOS.md). It includes config-copy commands,
restart behavior, logs, and the Chrome sandbox setting required by CasaOS.

## Build

Run inside Ubuntu as your normal user, not root:

```bash
bash install.sh --install-deps
bash install.sh --build
```

The pinned Rust toolchain, Cargo lockfile and npm lockfile are used. Tests run
before release binaries are staged in `build/runtime/`, followed by an isolated
HTTP/login/preset smoke test. The build does not change a running installation.
Compilation uses `~/.cache/tesla-moonlight-ubuntu/target` by default, so WSL builds
keep the large compiler cache on Linux storage. Internet access is required for
initial dependency downloads. Linux binaries must be built for the target CPU
and compatible distribution; an Ubuntu 26.04 binary is not promised to run on
older Ubuntu releases.

## Install on a real Ubuntu desktop

1. Install the official Sunshine package matching Ubuntu 26.04 and your CPU:

   ```bash
   python3 scripts/install-host-package.py sunshine
   # Needed if this project will run your Cloudflare tunnel:
   python3 scripts/install-host-package.py cloudflared
   ```

   The helper verifies the release asset SHA-256 and refuses to substitute a
   package for a different Ubuntu version. `--tag TAG` selects a particular
   official release. Alternatively follow the official
   [Sunshine installation](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2getting__started.html)
   and [cloudflared downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).

2. Prepare your private settings:

   ```bash
   bash install.sh --prepare-config
   nano config/install.json
   ```

   Set a unique `web_password` (at least 16 characters). For internet access set
   `public_hostname`, `cloudflare_turn_token_id`, `cloudflare_turn_api_token`,
   and optionally `cloudflare_tunnel_token`. The Tunnel connector token and TURN
   API token are different credentials. Create TURN credentials in
   [Cloudflare Realtime](https://developers.cloudflare.com/realtime/turn/).
   An empty hostname and empty Cloudflare fields provide **local-only** testing.

3. From a terminal in the logged-in Ubuntu desktop:

   ```bash
   bash install.sh
   ```

   This installs under `~/.local/share/tesla-moonlight-ubuntu`, preserves existing
   Sunshine settings/apps and pairings, and enables user services. Sunshine's
   official package must provide `app-dev.lizardbyte.app.Sunshine.service`. Secrets are mode 0600 in a
   mode 0700 runtime state directory; the TURN secret is passed to the service
   through an EnvironmentFile and is never written to browser assets. Keep the
   private input JSON on a Linux filesystem if Windows drive permissions cannot
   enforce 0600. Do not commit or share it.

4. Open `https://localhost:47990` on Ubuntu to finish Sunshine setup. Its local
   self-signed certificate needs a local exception. Choose the correct capture
   display and audio output if automatic detection does not select them.
   Leave encoder selection automatic to use NVENC/VAAPI when available.

5. Open `http://localhost:43780`, enter your web password, add host `127.0.0.1`
   with the default port, and pair. Enter the displayed PIN in Sunshine's PIN
   page. Launch **Ubuntu Desktop** (or **Desktop** on an existing Sunshine setup).

6. In the Cloudflare Tunnel dashboard publish your hostname to
   `http://127.0.0.1:43780`. If you already manage a tunnel, use that connector and
   leave `cloudflare_tunnel_token` empty. Ensure the route supports WebSockets.
   Public DNS and a working tunnel route must exist; the installer cannot create
   your account/domain/route from a connector token.

7. While parked, open `https://YOUR_HOSTNAME` in the Tesla browser, log in, select
   the paired Ubuntu host, and start the desktop. Start with **Reliable** quality;
   then try **High** or **Ultra**. A user gesture may be required to start audio.

## Ubuntu desktop notes

- A running, logged-in desktop and a usable monitor/virtual output are required.
  Lock screens, logout and display power-off can interrupt capture. Headless
  systems need their own supported virtual display or HDMI dummy plug.
- Wayland capture support depends on Sunshine, the compositor, permissions and
  GPU. Complete any desktop capture portal consent locally. The diagnostic
  script reports DRM and `/dev/uinput` access; follow Sunshine's official Linux
  setup for capture/input permissions rather than running the service as root.
- Window (1600×1200), Full (1920×1080), and Auto select the stream size. In the
  private WSL desktop they also resize the Xorg dummy display to match, avoiding
  capture letterboxing. Auto matches the browser aspect ratio within 1920×1080;
  leaving the player restores 1600×900. Native physical monitors retain
  stream-only behavior unless an administrator configures a display helper.
- Services start with the user session. This installer does not enable autologin
  or linger, and starting a user manager alone does not create a desktop.
- YouTube Remote is available using the Ubuntu installation below. The UB1818
  extension and BetterDisplay helper are not included. Other apps can be streamed through
  Sunshine. The inherited ASCII software-keyboard path assumes a US keyboard
  layout; other layouts and Unicode input need device testing.

## WSL2 first

From Windows PowerShell:

```powershell
wsl -d Ubuntu-26.04
```

Inside WSL:

```bash
cd /mnt/d/AI/codex/sunshine-ubuntu
bash install.sh --build
bash install.sh --install-wsl-deps
bash install.sh --wsl
```

Open `http://localhost:43780` from Windows, log in, select **Ubuntu 26.04 WSL
Desktop**, then launch **Ubuntu WSL Desktop**. The installer creates an isolated
resizable XFCE/Xorg dummy desktop, a private PulseAudio output, a software H.264 Sunshine
host, and automatically pairs it with the browser bridge. It does not need a
physical Ubuntu monitor or WSL GPU capture. The generated login password is in
`~/.config/tesla-moonlight-ubuntu/local-test.json`, field `web_password`.

This setup has been tested with real browser video, audio decoding, mouse and
keyboard input. Software encoding consumes CPU; start with Reliable quality.
The WSL desktop is separate from Windows and WSLg application windows. Gamepads
are not validated: this WSL kernel does not expose the required UHID module.
Services run only while the distribution and its user manager are running;
Windows sleep or WSL shutdown disconnects the session.

**The localhost address is only for testing on this Windows computer.** Tesla
cannot use it. For the internet route, prepare the Cloudflare settings described
above, install cloudflared if needed, then run:

```bash
bash install.sh --wsl --config ~/.config/tesla-moonlight-ubuntu/internet.json
```

Use your configured HTTPS hostname in Tesla after creating the tunnel route.
TURN is required by this deployment for media across WSL NAT and internet
networks; forwarding only HTTP does not provide a working media path. A same-LAN
deployment needs a trusted HTTPS origin and a routable WebRTC media path too.
The local-trial installer refuses to replace an existing public deployment.

If the tunnel token is available before TURN credentials, you can connect the
tunnel separately while preserving the existing authenticated local bridge:

```bash
python3 scripts/configure-tunnel.py --hostname YOUR_HOSTNAME < /path/to/private-tunnel-token
```

For an existing dashboard origin such as `http://localhost:8080`, add
`--origin-port 8080` to create a loopback-only TCP forwarding socket to 43780.
This also forwards WebSockets. The helper saves private `internet.json` settings;
fill its two TURN fields and then run `--wsl --config` as above. A reachable page
alone does not validate internet media streaming.

`scripts/configure-turn.py` accepts the two TURN credential fields as JSON on
stdin, validates them against Cloudflare without printing generated credentials,
and completes `--wsl --config` using the saved private deployment settings.

Sunshine's local admin credentials are generated separately in
`~/.config/tesla-moonlight-ubuntu/sunshine-wsl.json`. The admin interface is
`https://localhost:47990`; do not publish it. Desktop state, applications,
Sunshine pairing and private audio files live under
`~/.local/share/tesla-moonlight-ubuntu/wsl-desktop` and survive reinstall.
Use `--bridge-only` only when you already manage a separate Sunshine host.

The packaged archive includes source and the tested x86-64 Linux runtime under
`build/runtime/`. On Ubuntu 26.04 x86-64 you can use it without recompiling:
install Sunshine/cloudflared as appropriate, prepare private settings, then run
`bash install.sh` (native desktop) or `bash install.sh --wsl` (WSL desktop).
Other architectures must build from source first.

## YouTube Remote and the Sunshine menu

After installing the desktop and web bridge, run inside Ubuntu:

```bash
bash install.sh --install-youtube-deps
bash install.sh --youtube
```

Refresh the app list and choose **YouTube Remote**. This installs the original
Tesla Touch drawer: search, YouTube links, directional selection, paging,
play/pause, ±10-second seeking, previous/next, volume/mute, captions, player
fullscreen, and menu opacity. **Stream & input settings** contains View,
Window/Full/Auto resolution, Reliable/High/Ultra quality and stream diagnostics.
The × button closes only the isolated YouTube browser and returns to the desktop.
Disconnect cleanup pauses playback after a grace period; reconnects retain the
dedicated profile. Signing into YouTube is optional and stays in that profile.

`tesla-youtube-browser` owns only this app's Chrome process. The original local
controller runs as `tesla-youtube-control`; ports 9227/9228 remain loopback-only.
Its token is never sent to the Tesla browser. Existing Sunshine apps are retained
and backed up when installing this app. YouTube's layout can change independently
of this project, so selectors and the injected touch layout may need updates.

The Ubuntu applications menu also contains **Sunshine Settings**, opening the
local, authenticated management page at `https://localhost:47990`. The public
tunnel continues to expose only Moonlight Web. On the WSL installation, admin
credentials are in `~/.config/tesla-moonlight-ubuntu/sunshine-wsl.json`.

## Operations

```bash
bash install.sh --check
systemctl --user status tesla-moonlight-web
journalctl --user -u tesla-moonlight-web -n 80
# WSL capture and encoder logs:
journalctl --user -u tesla-wsl-sunshine -n 80
systemctl --user restart tesla-moonlight-web
bash scripts/uninstall-services.sh
```

Changing private install settings requires rerunning `bash install.sh` (or
`--wsl --config PATH` for WSL). Existing TOTP configuration and pairings are retained. Changing
the password does not revoke previously issued login sessions: to revoke them,
stop the web service, remove its private `server/sessions.json`, then restart.
The uninstaller removes only this project's services and preserves data.

`--no-start` installs files without enabling or starting services; use it only
when the existing runtime is stopped. `--config PATH` selects a private settings
file and `--prefix PATH` selects a runtime directory. Do not move an installed
runtime without rerunning setup, because the service uses absolute paths.

For blank video: check Sunshine capture/encoder logs first. For a page that loads
but streaming stalls: check TURN credentials, outbound network access and the
browser connection stats. Do not expose Sunshine's management port through your
public tunnel; only route the web bridge on port 43780.

## Validation

```bash
python3 -m unittest discover -s tests -v
shellcheck install.sh scripts/*.sh
bash scripts/build-runtime.sh
```

See [docs/VALIDATION.md](docs/VALIDATION.md) for what was actually tested. GitHub
Actions builds the same source in Ubuntu 26.04 and uploads the staged runtime.
