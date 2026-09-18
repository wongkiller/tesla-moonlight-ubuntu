// One-time, idempotent migration of the imported Mac fork. Kept for provenance.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../moonlight-web-stream-tsla/moonlight-web/web-server/', import.meta.url));
function edit(file, transform) {
    const text = readFileSync(root + file, 'utf8').replaceAll('\r\n', '\n');
    writeFileSync(root + file, transform(text));
}
for (const [file, profilePath] of [['web/stream.ts', './platform.js'], ['web/stream/index.ts', '../platform.js']]) {
    edit(file, text => {
        if (!text.includes('import { TESLA_PROFILE }')) text = `import { TESLA_PROFILE } from "${profilePath}";\n` + text;
        return text.replaceAll('location.hostname === "moonlight.example.com"', 'TESLA_PROFILE')
            .replaceAll('location.hostname !== "moonlight.example.com"', '!TESLA_PROFILE')
            .replaceAll('MacDisplay', 'Display').replaceAll('macDisplay', 'display')
            .replaceAll('physical Mac monitor', 'display preset')
            .replaceAll('Driving · Mac 1600×1200', 'Window · Stream 1600×1200')
            .replaceAll('Fullscreen · Mac 1920×1080', 'Fullscreen · Stream 1920×1080')
            .replaceAll('Native · Mac 5120×1440', 'Auto · Browser viewport')
            .replaceAll('label: "Driving"', 'label: "Window"')
            .replaceAll('matching Mac display mode', 'matching stream preset');
    });
}
edit('web/api.ts', text => text.replaceAll('MacDisplay', 'Display'));
edit('src/api/mod.rs', text => text.replaceAll('MacDisplay', 'Display')
    .replaceAll('set_mac_display_preset', 'set_display_preset')
    .replaceAll('COCKPIT_MAC_DISPLAY_HELPER', 'COCKPIT_DISPLAY_HELPER')
    .replace('warn!("[Display] COCKPIT_DISPLAY_HELPER is not configured");\n        return HttpResponse::ServiceUnavailable().finish();',
        '// Ubuntu/Wayland: change the negotiated stream size without changing\n        // the physical display. An optional administrator-supplied helper may\n        // implement monitor switching; it is never required for streaming.\n        return HttpResponse::Ok().json(serde_json::json!({\n            "preset": preset, "mode": "stream-only", "display_changed": false\n        }));'));
// An unattended Linux service must report startup errors to systemd and exit.
edit('src/main.rs', text => text.replace('info!("Error: {err:?}");', 'log::error!("Error: {err:?}");\n        std::process::exit(1);')
    .replace('if !exit_signal.load(Ordering::Relaxed) {', 'if cfg!(windows) && !exit_signal.load(Ordering::Relaxed) {'));
