# Ubuntu port validation — 2026-09-18

Environment actually used:

- User's `Ubuntu-26.04` WSL2 distribution, user `omega`.
- Ubuntu 26.04.1 LTS, x86-64, glibc 2.43.
- WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`.
- Pinned Rust `nightly-2025-09-01` (1.91.0-nightly).
- Linux Node.js 22 from Ubuntu, native C/C++/Clang/CMake toolchain.

Passed:

1. `cargo test --locked` for the five deployed crates: 49 tests (38 common,
   11 web-server); no failures. The frontend binding-generation step also ran.
2. Locked npm dependency installation, TypeScript build and asset cache stamping.
3. Native optimized Linux ELF `web-server` and `streamer` builds.
4. Seven Python installer unit tests, Python syntax checks and ShellCheck.
5. Isolated real-binary smoke test: page/assets return HTTP 200, HTML cache policy,
   wrong password rejected, protected endpoint rejects anonymous access,
   correct login returns a session, all three display presets return stream-only
   success, unknown preset is rejected, browser configuration does not expose the
   TURN API-token environment name, invalid startup JSON exits nonzero.
6. Real installer integration test in a temporary Linux HOME: repeated install,
   path containing spaces, systemd unit validation, 0700/0600 state permissions,
   existing pairing/session/TOTP state retained.
7. Installed user service in WSL2: `active/running`, zero automatic restarts;
   loopback HTTP 200 verified both inside WSL and from Windows.
8. Official Sunshine `v2026.914.233613` installed from its verified Ubuntu 26.04
   amd64 release package. Private X11/XFCE desktop, PulseAudio null sink and
   Sunshine services are active. Automatic pairing completed; rerunning pairing
   correctly reports the existing paired host.
9. Real browser-to-Sunshine stream: H.264 video received and decoded at about
   30 fps, 1,797 decoded frames after 60 seconds, zero dropped frames and zero
   packet loss in that sample. The screenshot shows the actual XFCE terminal.
10. Browser mouse focus and keyboard input executed `echo test` in the remote
    Ubuntu terminal and displayed `test`. The browser software keyboard also
    executed `echo software-keyboard-ok` and displayed the expected output.
11. The Opus data-channel audio pipeline received and decoded audio, with zero
    decoder errors and zero underruns in the 60-second sample. A low-volume
    three-second tone was also injected into the private output. Human audible
    playback and Tesla speakers have not been checked.
12. Complete `bash install.sh --wsl` reinstall passed with the existing pairing
    retained; diagnostics report all five services active and HTTP 200 from
    both Sunshine and the web bridge. Installer tests, syntax checks and
    ShellCheck passed after the WSL integration changes.

The live stream exposed two inherited ICE assumptions that were corrected:
172.16/12 interfaces are no longer excluded (WSL uses one), and the relay-only
watchdog no longer aborts a valid local direct-media connection. The full Rust
test suite and release build passed again after these changes. WSL desktop apps
are explicitly directed to X11 to prevent them opening in WSLg outside capture.

The installer integration test found and fixed quoting errors in systemd
WorkingDirectory and EnvironmentFile paths. They now pass systemd's own parser.

Installed local trial:

- URL: `http://localhost:43780`
- Service: `systemctl --user status tesla-moonlight-web`
- Runtime: `/home/omega/.local/share/tesla-moonlight-ubuntu`
- Local password: `web_password` in
  `/home/omega/.config/tesla-moonlight-ubuntu/local-test.json` (mode 0600).
- Paired Sunshine host: **Ubuntu 26.04 WSL Desktop**, application **Ubuntu WSL
  Desktop** and **YouTube Remote**. The host captures a private resizable Xorg
  dummy display using software x264 (1600×900 when idle).
- Additional services: `tesla-wsl-x11`, `tesla-wsl-audio`, `tesla-wsl-desktop`,
  `tesla-wsl-sunshine`.
- Cloudflare Tunnel now connects `ubuntu-sunshine.isese.com` to the authenticated
  bridge. Its existing dashboard origin `localhost:8080` is forwarded to 43780
  through a loopback-only systemd socket proxy. HTTPS returned the correct
  Moonlight page with HTTP 200 using the current public DNS A record. The local
  resolver initially retained a negative DNS response for the new hostname.
- TURN credentials were validated with Cloudflare and installed in private
  configuration. The public browser logged in successfully and streamed the
  real desktop. Both selected ICE candidates are `relay` over UDP (not a direct
  LAN connection), at about 30 fps and 40–41 ms RTT in the initial sample, with
  zero video packet loss or dropped frames. Opus decoding had zero errors and
  underruns in that sample. Tesla hardware remains untested.
- Official cloudflared `2026.9.1` installed and ready for tunnel configuration.
- Installed build tools in WSL through Ubuntu apt and the pinned Rust toolchain
  through rustup. No Windows host streaming configuration was changed.

Version 0.2.0 validation:

- Rebuilt release runtime and frontend; all 49 Rust tests and real HTTP smoke
  checks passed, including valid Auto dimensions and rejected incomplete, odd,
  zero and excessive dimensions. Seven installer unit tests, Python/Node syntax
  checks and ShellCheck passed.
- Replaced fixed-size Xvfb with rootless Xorg dummy. Via the public browser's
  actual resolution menu, xrandr confirmed Window 1600×1200, Full 1920×1080 and
  Auto 1642×1080 for the test viewport. Separate 1440×1080 helper check passed.
- YouTube Remote appears in the Sunshine app list. Public browser testing
  displayed real YouTube home/search results and video advertising playback;
  search, directional selection, open, volume and mute controls responded.
  Exit stopped only the dedicated Chrome service and exposed the XFCE desktop.
- Original YouTube controls and expandable stream settings are included, with
  opacity, quality, view fitting, zoom, shadow boost and statistics controls.
- Reinstallation and a fresh full-screen YouTube launch passed. Anonymous/wrong
  helper tokens returned 404; authenticated unsupported actions returned 400.
  Final Auto stream sample showed 30 fps, 38 ms RTT, zero dropped frames, zero
  packet loss and zero audio decoder errors/underruns. The release archive was
  scanned against configured private values; none were included.
- Chrome uses software rendering and disables QUIC only under WSL. Initial blank
  page loading was resolved after using HTTPS/TCP. Browser profile and control
  token remain in the private runtime; debugging/control ports bind to loopback.
- Tesla vehicle playback, physical PS4 mappings, human audible audio and a native
  Ubuntu GPU session still require hardware testing.

Not yet validated:

- Native Ubuntu physical desktop capture, GPU encoding and gamepad permissions.
- Tesla hardware/browser playback, keyboard layout, touch behavior and latency.
- Tesla/carrier-network performance and audible playback from Tesla speakers.
- Native Wayland/X11 session lifecycle and reboot with a logged-in desktop.
- ARM64 or older Ubuntu versions. The helper can select official ARM64 packages,
  but an ARM64 native build has not been run.
- The new GitHub Actions workflow has been created but not run on GitHub.

This WSL instance has no `/dev/dri` and no user write access to `/dev/uinput`.
The dedicated X11 desktop with software encoding works around the capture
limitation; Sunshine's X11 input backend worked for the tested keyboard/mouse.
The installed kernel lacks the UHID module needed for virtual gamepads.
