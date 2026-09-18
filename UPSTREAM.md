# Source and licensing

This Ubuntu port imports the complete streaming source from:

- Repository: https://github.com/wongkiller/tesla-moonlight-mac
- Commit: `f43dee26a4546229b310630185f137c5917d4e1f`
- Imported: 2026-09-18
- Imported directory: `moonlight-web-stream-tsla/`
- Original upstreams: https://github.com/Argon2000/moonlight-web-stream-tsla and https://github.com/MrCreativ3001/moonlight-web-stream

The YouTube controller, injected touch layout and app artwork in
`extensions/youtube-remote/` are also imported from the same reference commit.
Their Ubuntu lifecycle and systemd integration replace the macOS launch scripts.

The imported streaming code is GPL-3.0-or-later; see `LICENSE` and the preserved
nested license files (including Moonlight Common C and ENet). New Ubuntu support
files in this project are also GPL-3.0-or-later. Existing notices are preserved.
Sunshine and cloudflared are separate upstream installations. No macOS binaries,
Keychain data, saved pairings or original deployment secrets are shipped.

Ubuntu changes: Bash/Python installation, native Linux builds, systemd user
services, protected runtime configuration, isolated WSL X11/audio/Sunshine desktop,
automatic local pairing, WSL-compatible ICE selection, hostname-independent
Tesla browser presets, stream-only resolution selection, noninteractive startup
failure reporting, Linux validation, YouTube Remote and dynamic virtual-display
presets. The original Apple-only launch scripts and physical-display binary
are not installed by this port.

`upstream-mac/`, when present in the development workspace, is the ignored
reference clone; it is not needed to build or install this project.
