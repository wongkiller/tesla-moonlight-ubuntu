# Tesla Mac release

Local release tag: `tesla-mac-v1.0.0`

This branch adds the macOS/Tesla production path used by the release under
`../releases/tesla-mac-v1.0.0/`, including relay-only Cloudflare TURN,
macOS Keychain-safe TLS handling, Tesla renderer recovery and diagnostics,
software-keyboard translation, and touchscreen mouse gestures.

Frontend build: `tesla-drag-gestures-20260823-15`.

Gesture mapping:

- Tap: click
- Two taps: double-click
- Stationary long touch: double-click
- Quick slide: cursor move
- Hold for 350 ms, then slide: left-button drag
- Lift: release

The release is based on upstream commit
`fc900971fe533329cec00ba33d39c3aa22a7483a`.
