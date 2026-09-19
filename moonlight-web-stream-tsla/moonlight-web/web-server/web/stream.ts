import { TESLA_PROFILE } from "./platform.js";
import "./polyfill/index.js"
import { Api, apiGetApps, apiHostCancel, apiSetDisplayPreset, apiUb1818Control, apiYoutubeControl, getApi, logout, DisplayPreset, Ub1818ControlAction, Ub1818ControlResponse, YoutubeControlAction, YoutubeControlResponse } from "./api.js";
import { Component } from "./component/index.js";
import { showErrorPopup } from "./component/error.js";
import { getStreamerSize, InfoEvent, Stream } from "./stream/index.js"
import { getModalBackground, Modal, showMessage, showModal } from "./component/modal/index.js";
import { getSidebarRoot, setSidebar, setSidebarExtended, setSidebarStyle, toggleSidebar, Sidebar } from "./component/sidebar/index.js";
import { defaultStreamInputConfig, MouseMode, ScreenKeyboardSetVisibleEvent, StreamInputConfig } from "./stream/input.js";
import { defaultStreamSettings, getLocalStreamSettings, StreamSettings } from "./component/settings_menu.js";
import { SelectComponent } from "./component/input.js";
import { getStandardVideoFormats, getSupportedVideoFormats } from "./stream/video.js";
import { CanvasRenderer } from "./stream/canvas.js";
import { StreamCapabilities, StreamKeys } from "./api_bindings.js";
import { getTeslaVirtualSwapOverride, setTeslaVirtualSwapOverride } from "./stream/gamepad.js";
import { KeyboardModeEvent, ScreenKeyboard, TextEvent } from "./screen_keyboard.js";
import { requestKeyboardLock } from "./iframe.js";
import { FormModal } from "./component/modal/form.js";
import { StreamStatsOverlay } from "./component/stream_stats.js";

function getBuildVersionTag(): string {
    try {
        const url = new URL(import.meta.url)
        const version = url.searchParams.get("v")
        return version ?? "dev"
    } catch {
        return "unknown"
    }
}

type TeslaResolutionMode = "auto" | "windowed" | "fullscreen"
type TeslaQualityMode = "reliable" | "high" | "ultra"
type RemoteViewMode = "fit-height" | "fit-width" | "fill"
const TESLA_RESOLUTION_MODE_KEY = "mlTeslaResolutionModeV2"
const TESLA_QUALITY_MODE_KEY = "mlTeslaQualityMode"
const TESLA_ZOOM_LOCK_KEY = "mlTeslaZoomLocked"
const REMOTE_VIEW_MODE_KEY = "mlRemoteViewModeV2"
const YOUTUBE_MENU_OPACITY_KEY = "mlYoutubeMenuOpacity"
const SCREEN_BRIGHTNESS_KEY = "mlScreenBrightness"
let preserveDisplayAcrossReload = false

function getTeslaResolutionMode(): TeslaResolutionMode {
    const saved = localStorage.getItem(TESLA_RESOLUTION_MODE_KEY)
    return saved === "auto" || saved === "fullscreen" ? saved : "windowed"
}

function setTeslaResolutionMode(mode: TeslaResolutionMode) {
    localStorage.setItem(TESLA_RESOLUTION_MODE_KEY, mode)
}

function getTeslaQualityMode(): TeslaQualityMode {
    const saved = localStorage.getItem(TESLA_QUALITY_MODE_KEY)
    return saved === "reliable" || saved === "ultra" ? saved : "high"
}

function setTeslaQualityMode(mode: TeslaQualityMode) {
    localStorage.setItem(TESLA_QUALITY_MODE_KEY, mode)
}

function isIPadBrowser(): boolean {
    return /iPad/i.test(navigator.userAgent)
        || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
}

function getRemoteViewMode(): RemoteViewMode {
    const saved = localStorage.getItem(REMOTE_VIEW_MODE_KEY)
    if (saved === "fit-height" || saved === "fit-width" || saved === "fill") return saved
    // iPad Safari has a substantially different aspect ratio from Tesla and
    // should show every source edge. Tesla keeps the immersive fill default.
    return isIPadBrowser() ? "fit-height" : "fill"
}

function setRemoteViewMode(mode: RemoteViewMode) {
    localStorage.setItem(REMOTE_VIEW_MODE_KEY, mode)
}

function getYoutubeMenuOpacity(): number {
    const saved = Number.parseInt(localStorage.getItem(YOUTUBE_MENU_OPACITY_KEY) ?? "82", 10)
    return Number.isFinite(saved) ? Math.min(100, Math.max(25, saved)) : 82
}

function setYoutubeMenuOpacity(value: number) {
    localStorage.setItem(YOUTUBE_MENU_OPACITY_KEY, String(Math.round(value)))
}

function applyYoutubeMenuOpacity(value: number) {
    const root = getSidebarRoot()
    const opacity = Math.min(100, Math.max(25, value)) / 100
    root?.style.setProperty("--youtube-menu-alpha", opacity.toFixed(2))
    root?.style.setProperty("--youtube-card-alpha", Math.max(0.08, opacity - 0.24).toFixed(2))
    root?.style.setProperty("--youtube-menu-blur", `${Math.max(0, Math.round((opacity - 0.25) * 18))}px`)
}

function getScreenBrightness(): number {
    const saved = Number.parseInt(localStorage.getItem(SCREEN_BRIGHTNESS_KEY) ?? "0", 10)
    return Number.isFinite(saved) ? Math.min(50, Math.max(-50, saved)) : 0
}

function setScreenBrightness(value: number) {
    localStorage.setItem(SCREEN_BRIGHTNESS_KEY, String(Math.round(value)))
}

function formatBrightnessOffset(value: number): string {
    return value > 0 ? `+${value}` : String(value)
}

function remoteViewModeLabel(mode: RemoteViewMode): string {
    if (mode === "fit-height") return "Fit Height · show top + bottom"
    if (mode === "fit-width") return "Fit Width · show left + right"
    return "Fill Screen · stretch"
}

function reloadStreamKeepingDisplay() {
    preserveDisplayAcrossReload = true
    window.location.reload()
}

function getTeslaZoomLocked(): boolean {
    // Lock is the safe default: two fingers scroll instead of accidentally
    // changing the local stream zoom. Only an explicit "unlocked" opts out.
    return localStorage.getItem(TESLA_ZOOM_LOCK_KEY) !== "unlocked"
}

function setTeslaZoomLocked(locked: boolean) {
    localStorage.setItem(TESLA_ZOOM_LOCK_KEY, locked ? "locked" : "unlocked")
}

function getBrowserViewportSize(): [number, number] {
    const viewportWindow = window as typeof window & {
        __syncTeslaViewport?: () => { layoutWidth: number, layoutHeight: number }
    }
    const managed = viewportWindow.__syncTeslaViewport?.()
    if (managed) {
        return [Math.max(1, managed.layoutWidth), Math.max(1, managed.layoutHeight)]
    }
    const visual = window.visualViewport
    return [
        Math.max(1, visual?.width || document.documentElement.clientWidth || window.innerWidth || 1),
        Math.max(1, visual?.height || document.documentElement.clientHeight || window.innerHeight || 1),
    ]
}

function roundEven(value: number): number {
    return Math.max(2, Math.floor(value / 2) * 2)
}

function getTeslaStreamSize(mode: TeslaResolutionMode, viewport: [number, number]): [number, number] {
    // Match the Ubuntu virtual display and encoder dimensions.
    if (mode === "windowed") return [1600, 1200]
    if (mode === "fullscreen") return [1920, 1080]

    // Auto follows the current browser pane. This also tolerates Tesla
    // firmware updates that change CSS DPR or the available browser area.
    const [viewportWidth, viewportHeight] = viewport
    const aspect = viewportWidth / viewportHeight
    const maxWidth = 1920
    const maxHeight = 1080
    const maxAspect = maxWidth / maxHeight
    return aspect >= maxAspect
        ? [maxWidth, roundEven(maxWidth / aspect)]
        : [roundEven(maxHeight * aspect), maxHeight]
}

function teslaResolutionModeLabel(mode: TeslaResolutionMode): string {
    if (mode === "windowed") return "Window · Stream 1600×1200"
    if (mode === "fullscreen") return "Fullscreen · Stream 1920×1080"
    return "Auto · Browser viewport"
}

function displayPresetForMode(mode: TeslaResolutionMode): DisplayPreset {
    if (mode === "windowed") return "driving"
    if (mode === "fullscreen") return "fullscreen"
    return "native"
}

function teslaQualityModeLabel(mode: TeslaQualityMode): string {
    if (mode === "reliable") return "Reliable · 1.6 Mbps"
    if (mode === "ultra") return "Ultra · 6 Mbps"
    return "High · 4 Mbps"
}

function getTeslaQualitySettings(mode: TeslaQualityMode): { bitrate: number, fps: number, jitterBufferMs: number } {
    if (mode === "reliable") return { bitrate: 1600, fps: 24, jitterBufferMs: 220 }
    if (mode === "ultra") return { bitrate: 6000, fps: 30, jitterBufferMs: 180 }
    return { bitrate: 4000, fps: 30, jitterBufferMs: 200 }
}

async function startApp() {
    const api = await getApi()

    const rootElement = document.getElementById("root");
    if (rootElement == null) {
        showErrorPopup("couldn't find root element", true)
        return;
    }

    // Get Host and App via Query
    const queryParams = new URLSearchParams(location.search)

    const hostIdStr = queryParams.get("hostId")
    const appIdStr = queryParams.get("appId")
    if (hostIdStr == null || appIdStr == null) {
        await showMessage("No Host or no App Id found")

        window.close()
        return
    }
    const hostId = Number.parseInt(hostIdStr)
    const appId = Number.parseInt(appIdStr)

    if (TESLA_PROFILE) {
        try {
            const mode = getTeslaResolutionMode()
            await apiSetDisplayPreset(api, displayPresetForMode(mode), false, getTeslaStreamSize(mode, getBrowserViewportSize()))
        } catch (error) {
            showErrorPopup(`Could not change the display preset: ${String(error)}`)
        }

        // Normal navigation away from the player restores the desktop. A
        // resolution-button reload opts out because the next page immediately
        // applies the newly selected preset.
        window.addEventListener("pagehide", () => {
            if (preserveDisplayAcrossReload) return
            void apiSetDisplayPreset(api, "native", true).catch(() => undefined)
        }, { once: true })
    }

    // event propagation on overlays
    const sidebarRoot = getSidebarRoot()
    if (sidebarRoot) {
        stopPropagationOn(sidebarRoot)
        preventHorizontalNavigationOn(sidebarRoot)
    }

    const modalBackground = getModalBackground()
    if (modalBackground) {
        stopPropagationOn(modalBackground)
    }

    // Start and Mount App
    let appTitle = ""
    try {
        const apps = await apiGetApps(api, { host_id: hostId, force_refresh: false })
        appTitle = apps.find(candidate => candidate.app_id === appId)?.title ?? ""
    } catch (error) {
        console.warn("Could not identify streamed app for local controls", error)
    }

    const app = new ViewerApp(api, hostId, appId, appTitle)
    app.mount(rootElement)
}

// Prevent starting transition
window.requestAnimationFrame(() => {
    // Note: elements is a live array
    const elements = document.getElementsByClassName("prevent-start-transition")
    while (elements.length > 0) {
        elements.item(0)?.classList.remove("prevent-start-transition")
    }
})

startApp()

class ViewerApp implements Component {
    private api: Api
    private hostId: number

    private sidebar: ViewerSidebar

    private div = document.createElement("div")
    private videoElement = document.createElement("video")
    private canvasElement = document.createElement("canvas")

    private stream: Stream | null = null

    private canvasRenderer: CanvasRenderer | null = null
    private settings: StreamSettings
    private statsOverlay: StreamStatsOverlay

    private streamerSize: [number, number]

    private inputConfig: StreamInputConfig = defaultStreamInputConfig()
    private previousMouseMode: MouseMode
    private toggleFullscreenWithKeybind: boolean
    private hasShownFullscreenEscapeWarning = false
    
    private wakeLock: WakeLockSentinel | null = null
    private hasInteracted = false
    private cachedStreamRect: DOMRect | null = null
    private pollRafId: number | null = null
    private pollTimerId: ReturnType<typeof setTimeout> | null = null
    private pollLoopRunning: boolean = false
    private reportedInputKinds = new Set<string>()
    private diagnosticTimers: Array<ReturnType<typeof setTimeout>> = []
    private diagnosticInterval: ReturnType<typeof setInterval> | null = null
    private diagnosticStartedAt = 0
    private diagnosticStateListenersAdded = false
    private lastDiagnosticVideoBytes = 0
    private lastDiagnosticVideoFrames = 0
    private lastDiagnosticAudioPackets = 0
    private lastDiagnosticCanvasDrawn = 0
    private lastDiagnosticAt = 0
    private consecutiveCanvasStalls = 0
    private latestVideoTrack: MediaStreamTrack | null = null
    private nativeVideoFallbackEnabled = false
    private videoRendererAttached = false
    private viewZoom = 1
    private viewZoomLocked = getTeslaZoomLocked()
    private pinchStartDistance: number | null = null
    private pinchStartZoom = 1
    private pinchActive = false
    private pinchLogStarted = false
    private isYoutubeRemote = false
    private isUb1818Remote = false
    private shadowBoost = 0
    private screenBrightness = 0
    private controllerPreviousButtons = new Map<number, boolean[]>()
    private controllerPreviousDirections = new Map<number, Record<string, boolean>>()
    private controllerRepeatAt = new Map<string, number>()
    private controllerKeyboardDown = new Set<number>()
    private controllerStatusUpdatedAt = 0

    constructor(api: Api, hostId: number, appId: number, appTitle: string) {
        this.api = api
        this.hostId = hostId
        this.isYoutubeRemote = appTitle === "YouTube Remote"
        this.isUb1818Remote = appTitle === "UB1818 Remote"
        try {
            const saved = localStorage.getItem("mlShadowBoost")
            if (saved !== null) {
                const v = parseFloat(saved)
                if (isFinite(v) && v >= 0 && v <= 1) this.shadowBoost = v
            }
        } catch (_) {}
        this.screenBrightness = getScreenBrightness()

        // Bind update loops
        this.onTouchUpdate = this.onTouchUpdate.bind(this)
        this.onGamepadUpdate = this.onGamepadUpdate.bind(this)

        // Configure sidebar
        this.sidebar = new ViewerSidebar(this, this.isYoutubeRemote, this.isUb1818Remote)
        setSidebar(this.sidebar)

        // Configure stream
        const settings = getLocalStreamSettings(hostId) ?? defaultStreamSettings()

        // The public Tesla endpoint is relay-only through Cloudflare TURN. Use
        // explicit field-tested presets instead of the generic settings page:
        // High (4 Mbps) is the quality-first default, Reliable preserves the
        // old low-bandwidth behavior, and Ultra is available for strong links.
        if (TESLA_PROFILE) {
            const viewport = getBrowserViewportSize()
            const resolutionMode = getTeslaResolutionMode()
            const [streamWidth, streamHeight] = getTeslaStreamSize(resolutionMode, viewport)
            const qualityMode = getTeslaQualityMode()
            const quality = getTeslaQualitySettings(qualityMode)
            settings.videoSize = "custom"
            settings.videoSizeCustom = { width: streamWidth, height: streamHeight }
            settings.fps = quality.fps
            settings.bitrate = quality.bitrate
            settings.jitterBufferMs = quality.jitterBufferMs
            settings.dontForceH264 = false
            // The Tesla fork renders through canvas so the browser's native
            // accelerated <video> surface cannot take touch input away from
            // the DOM. Ignore a stale per-browser setting that disabled it.
            settings.canvasRenderer = true
            // iPad Safari does not expose frames through
            // MediaStreamTrackProcessor. Start directly on its reliable native
            // video path rather than waiting three seconds for canvas fallback.
            if (isIPadBrowser()) settings.canvasRenderer = false
            settings.stretchToFit = getRemoteViewMode() === "fill"
            settings.useVideoWorker = false
            settings.useAudioWorker = true
            settings.keepAudioAlive = true
            settings.audioSampleQueueSize = Math.max(settings.audioSampleQueueSize, 4)
        }

        const [browserWidth, browserHeight] = getBrowserViewportSize()

        this.previousMouseMode = this.inputConfig.mouseMode
        this.toggleFullscreenWithKeybind = settings.toggleFullscreenWithKeybind

        // Create stats overlay early (before startStream which uses it async)
        this.statsOverlay = new StreamStatsOverlay()

        this.startStream(hostId, appId, settings, [browserWidth, browserHeight])

        this.streamerSize = getStreamerSize(settings, [browserWidth, browserHeight])

        this.settings = settings

        // Configure video element
        this.videoElement.classList.add("video-stream")
        this.videoElement.preload = "none"
        this.videoElement.controls = false
        this.videoElement.autoplay = true
        this.videoElement.disablePictureInPicture = true
        this.videoElement.playsInline = true
        this.videoElement.muted = true

        // Apply stretch-to-fit for video element mode
        if (TESLA_PROFILE) {
            this.applyNativeVideoViewMode()
        } else if(!this.settings.canvasRenderer && this.settings.stretchToFit) {
            this.videoElement.classList.add("video-stream-stretched")
        }

        // Configure canvas element
        if(this.settings.canvasRenderer) {
            this.canvasElement.classList.add("video-stream")
            this.div.appendChild(this.canvasElement)
            this.canvasRenderer = new CanvasRenderer(this.canvasElement, settings.stretchToFit, settings.useVideoWorker)
            this.videoElement.autoplay = false
        }

        this.div.appendChild(this.videoElement)

        // Stream setup starts before the DOM renderer is created. On fast local
        // Sunshine connections, Tesla can receive the video track before the
        // CanvasRenderer exists, so the one-shot videoTrack event is missed and
        // the browser decodes frames without ever drawing them. Reconcile the
        // renderer from the MediaStream as well as from the event.
        for (const delay of [0, 250, 1000]) {
            window.setTimeout(() => this.ensureVideoRenderer(`constructor-${delay}`), delay)
        }

        // Configure stats overlay
        this.statsOverlay.mount(this.div)
        if (!settings.showStreamStats) {
            this.statsOverlay.hide()
        }

        // Configure input
        this.addListeners(document)
        this.addListeners(document.getElementById("input") as HTMLDivElement)

        document.addEventListener("pointerlockchange", this.onPointerLockChange.bind(this))
        document.addEventListener("fullscreenchange", this.onFullscreenChange.bind(this))

        // Invalidate cached stream rect on resize
        window.addEventListener("resize", () => { this.cachedStreamRect = null })
        window.addEventListener("scroll", () => { this.cachedStreamRect = null }, true)
        this.videoElement.addEventListener("resize", () => { this.cachedStreamRect = null })
        // Also invalidate when the video element itself resizes (e.g. when the video
        // stream starts and its intrinsic dimensions become known, causing the element
        // to reflow from its initial min-width/min-height square into the correct ratio)
        new ResizeObserver(() => { this.cachedStreamRect = null }).observe(this.videoElement)

        window.addEventListener("gamepadconnected", this.onGamepadConnect.bind(this))
        window.addEventListener("gamepaddisconnected", this.onGamepadDisconnect.bind(this))
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") this.restoreTeslaMediaSession()
        })
        window.addEventListener("pageshow", () => this.restoreTeslaMediaSession())
        // Connect all gamepads
        const connectedGamepads = typeof navigator.getGamepads === "function"
            ? navigator.getGamepads()
            : []
        for (const gamepad of connectedGamepads) {
            if (gamepad != null) {
                this.onGamepadAdd(gamepad)
            }
        }
    }
    private addListeners(element: GlobalEventHandlers) {
        element.addEventListener("keydown", this.onKeyDown.bind(this), { passive: false })
        element.addEventListener("keyup", this.onKeyUp.bind(this), { passive: false })
        element.addEventListener("paste", this.onPaste.bind(this) as any)

        element.addEventListener("mousedown", this.onMouseButtonDown.bind(this), { passive: false })
        element.addEventListener("mouseup", this.onMouseButtonUp.bind(this), { passive: false })
        element.addEventListener("mousemove", this.onMouseMove.bind(this), { passive: false })
        element.addEventListener("wheel", this.onMouseWheel.bind(this), { passive: false })
        element.addEventListener("contextmenu", this.onContextMenu.bind(this), { passive: false })

        element.addEventListener("touchstart", this.onTouchStart.bind(this), { passive: false })
        element.addEventListener("touchend", this.onTouchEnd.bind(this), { passive: false })
        element.addEventListener("touchcancel", this.onTouchCancel.bind(this), { passive: false })
        element.addEventListener("touchmove", this.onTouchMove.bind(this), { passive: false })
    }

    private async startStream(hostId: number, appId: number, settings: StreamSettings, browserSize: [number, number]) {
        setSidebarStyle({
            edge: settings.sidebarEdge,
        })

        let supportedVideoFormats = getStandardVideoFormats()
        if (settings.dontForceH264) {
            supportedVideoFormats = await getSupportedVideoFormats()
        }

        this.stream = new Stream(this.api, hostId, appId, settings, supportedVideoFormats, browserSize)

        // Wire stats overlay to WebRTC peer (lazily resolved since peer is created async)
        this.statsOverlay.setPeerGetter(() => this.stream?.getPeer() ?? null)
        this.statsOverlay.setStreamGetter(() => this.stream)
        this.statsOverlay.setWorkerDiagnosticsGetter(() => this.getWorkerDiagnostics())
        this.statsOverlay.setInputDiagnosticsGetter(() => this.stream?.getInput().getInputDiagnostics() ?? null)
        this.statsOverlay.setStatsEnabledCallback((enabled) => {
            this.stream?.setStatsEnabled(enabled)
            this.canvasRenderer?.setStatsEnabled(enabled)
        })
        // Every 5 minutes while the stats overlay is open, log the full stats
        // dump to the server's console (visible without opening devtools —
        // useful since the Tesla browser has none).
        this.statsOverlay.setStatsReportCallback((text) => {
            this.stream?.sendClientLogMessage(text)
        })
        if (settings.showStreamStats) {
            this.statsOverlay.show()
        }

        // Add app info listener
        this.stream.addInfoListener(this.onInfo.bind(this))

        // Create connection info modal
        const connectionInfo = new ConnectionInfoModal()
        this.stream.addInfoListener(connectionInfo.onInfo.bind(connectionInfo))
        showModal(connectionInfo)

        // Set video
        if(!settings?.canvasRenderer) {
            this.videoElement.srcObject = this.stream.getMediaStream()
        }

        this.ensurePollLoopRunning()

        this.stream.getInput().addScreenKeyboardVisibleEvent(this.onScreenKeyboardSetVisible.bind(this))
        
        this.requestWakeLock();
    }
    
    private async requestWakeLock() {
        if (document.visibilityState !== "visible") return
        if (this.wakeLock && !this.wakeLock.released) return
        if ('wakeLock' in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
                this.wakeLock.addEventListener('release', () => {
                    console.log('Wake Lock was released');
                    this.wakeLock = null
                    if (document.visibilityState === "visible") {
                        setTimeout(() => { void this.requestWakeLock() }, 500)
                    }
                });
                console.log('Wake Lock is active');
            } catch (err) {
                console.error(`Wake Lock failed: ${err}`);
            }
        }
    }

    private restoreTeslaMediaSession() {
        if (!TESLA_PROFILE) return
        this.ensureVideoRenderer("resume")
        void this.requestWakeLock()
        this.stream?.resumeAudio()
        if (this.nativeVideoFallbackEnabled && this.videoElement.paused) {
            void this.videoElement.play().catch(error => {
                this.stream?.sendClientLogMessage(`[Tesla Resume] video play failed: ${String(error)}`)
            })
        }
        this.stream?.sendClientLogMessage(
            `[Tesla Resume] visibility=${document.visibilityState}; focus=${document.hasFocus()}`
        )
    }

    private async onInfo(event: InfoEvent) {
        const data = event.detail

        if (data.type == "app") {
            const app = data.app

            document.title = `Stream: ${app.title}`
        } else if (data.type == "connectionComplete") {
            this.sidebar.onCapabilitiesChange(data.capabilities)
            this.ensureVideoRenderer("connection-complete")
            this.scheduleTeslaDiagnostics()
        } else if (data.type == "videoTrack") {
            this.latestVideoTrack = data.track
            this.ensureVideoRenderer("video-track-event")
        } else if (data.type == "inputClientsChanged") {
            this.sidebar.onInputClientsChanged(data.count)
        }
    }

    private ensureVideoRenderer(reason: string): boolean {
        if (!this.settings?.canvasRenderer || !this.canvasRenderer) return false

        const track = this.latestVideoTrack
            ?? this.stream?.getMediaStream().getVideoTracks().find(candidate => candidate.readyState === "live")
            ?? this.stream?.getMediaStream().getVideoTracks()[0]
            ?? null
        if (!track) return false

        this.latestVideoTrack = track
        this.canvasElement.style.display = "block"
        this.canvasRenderer.setVideoTrack(track)
        if (!this.videoRendererAttached) {
            this.videoRendererAttached = true
            this.stream?.sendClientLogMessage(
                `[Tesla AV] attached canvas renderer from ${reason}; track=${track.readyState}; muted=${track.muted}`
            )
        }
        return true
    }

    private focusInput() {
        const inputElement = document.getElementById("input") as HTMLDivElement
        inputElement?.focus({ preventScroll: true })
    }

    recoverAfterScreenKeyboard() {
        // The soft keyboard changes Tesla's visual viewport and focus. Also
        // clear any gesture that began on an overlay control so a swallowed
        // touchend cannot leave the remote pointer permanently disabled.
        this.stream?.getInput().resetTouchState()

        const settleViewport = () => {
            window.scrollTo(0, 0)
            this.cachedStreamRect = null
            this.focusInput()
            this.stream?.resumeAudio()
        }
        settleViewport()
        window.setTimeout(settleViewport, 150)
        window.setTimeout(() => {
            settleViewport()
            if (this.nativeVideoFallbackEnabled) {
                this.canvasElement.style.display = "none"
                this.videoElement.style.display = "block"
                this.applyNativeVideoViewMode()
                void this.videoElement.play().catch(() => undefined)
            } else {
                this.ensureVideoRenderer("keyboard-close")
            }
            this.stream?.sendClientLogMessage(
                `[Tesla Keyboard] closed; input focus and viewport recovered; ` +
                `visual=${window.visualViewport?.width ?? window.innerWidth}x${window.visualViewport?.height ?? window.innerHeight}`
            )
        }, 500)
    }

    onUserInteraction() {
        this.stream?.resumeAudio();
        
        if (this.hasInteracted) return
        this.hasInteracted = true

        this.focusInput()

        if (this.videoElement) {
            this.videoElement.muted = false
            if(this.videoElement.paused) {
                this.videoElement.play().then(() => {
                    // Playing
                }).catch(error => {
                    console.error(`Failed to play videoElement: ${error.message || error}`);
                })
            }
        }
    }
    private onScreenKeyboardSetVisible(event: ScreenKeyboardSetVisibleEvent) {
        console.info(event.detail)
        const screenKeyboard = this.sidebar.getScreenKeyboard()

        const newShown = event.detail.visible
        if (newShown != screenKeyboard.isVisible()) {
            if (newShown) {
                screenKeyboard.show()
            } else {
                screenKeyboard.hide()
            }
        }
    }

    // Input
    getInputConfig(): StreamInputConfig {
        return this.inputConfig
    }
    setInputConfig(config: StreamInputConfig) {
        Object.assign(this.inputConfig, config)

        this.stream?.getInput().setConfig(this.inputConfig)
    }

    getStreamInput() {
        return this.stream?.getInput() ?? null
    }

    getWorkerDiagnostics() {
        return {
            stream: this.stream?.getWorkerDiagnostics() ?? null,
            canvas: this.canvasRenderer?.getWorkerDiagnostics() ?? null,
            canvasRendererEnabled: this.settings.canvasRenderer,
            workersAllowedBySettings: this.settings.useVideoWorker,
        }
    }

    private scheduleTeslaDiagnostics() {
        if (!TESLA_PROFILE) return

        // AudioWorklet/canvas counters are normally disabled with the visual
        // stats overlay. Tesla has no devtools, so keep only the lightweight
        // counters active for the server-side flight recorder.
        this.stream?.setStatsEnabled(true)
        this.canvasRenderer?.setStatsEnabled(true)

        for (const timer of this.diagnosticTimers) clearTimeout(timer)
        if (this.diagnosticInterval !== null) clearInterval(this.diagnosticInterval)
        this.diagnosticStartedAt = performance.now()
        this.lastDiagnosticAt = this.diagnosticStartedAt
        this.lastDiagnosticVideoBytes = 0
        this.lastDiagnosticVideoFrames = 0
        this.lastDiagnosticAudioPackets = 0
        this.lastDiagnosticCanvasDrawn = 0
        this.consecutiveCanvasStalls = 0
        this.diagnosticTimers = [3000, 8000, 15000].map(delay =>
            setTimeout(() => { void this.reportTeslaDiagnostics(delay) }, delay)
        )
        // Keep a low-volume flight recorder running after the initial probes.
        // This is essential for failures that appear minutes into a drive.
        this.diagnosticInterval = setInterval(() => {
            const elapsed = Math.round(performance.now() - this.diagnosticStartedAt)
            void this.reportTeslaDiagnostics(elapsed)
        }, 30000)

        const peer = this.stream?.getPeer()
        if (peer && !this.diagnosticStateListenersAdded) {
            this.diagnosticStateListenersAdded = true
            const logState = () => this.stream?.sendClientLogMessage(
                `[Tesla State] ice=${peer.iceConnectionState}; peer=${peer.connectionState}; ` +
                `signaling=${peer.signalingState}; gathering=${peer.iceGatheringState}; ` +
                `online=${navigator.onLine}; visibility=${document.visibilityState}`
            )
            peer.addEventListener("iceconnectionstatechange", logState)
            peer.addEventListener("connectionstatechange", logState)
            peer.addEventListener("signalingstatechange", logState)
            document.addEventListener("visibilitychange", logState)
            window.addEventListener("online", logState)
            window.addEventListener("offline", logState)
        }
    }

    private async reportTeslaDiagnostics(elapsedMs: number) {
        const peer = this.stream?.getPeer()
        if (!peer) return

        this.ensureVideoRenderer(`diagnostic-${elapsedMs}`)

        let video: any = null
        let audio: any = null
        let pair: any = null
        let codec: any = null
        let localCandidate: any = null
        let remoteCandidate: any = null
        try {
            const stats = await peer.getStats()
            stats.forEach((report: any) => {
                if (report.type === "inbound-rtp" && !report.isRemote) {
                    const summary = {
                        bytes: report.bytesReceived ?? 0,
                        packets: report.packetsReceived ?? 0,
                        lost: report.packetsLost ?? 0,
                        framesReceived: report.framesReceived,
                        framesDecoded: report.framesDecoded,
                        framesDropped: report.framesDropped,
                        keyFramesDecoded: report.keyFramesDecoded,
                        jitter: report.jitter,
                        jitterBufferDelay: report.jitterBufferDelay,
                        jitterBufferEmittedCount: report.jitterBufferEmittedCount,
                        decoder: report.decoderImplementation,
                        powerEfficient: report.powerEfficientDecoder,
                        codecId: report.codecId,
                    }
                    if (report.kind === "video" || report.mediaType === "video") video = summary
                    if (report.kind === "audio" || report.mediaType === "audio") audio = summary
                }
                if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
                    pair = {
                        rtt: report.currentRoundTripTime,
                        totalRtt: report.totalRoundTripTime,
                        availableOut: report.availableOutgoingBitrate,
                        bytesReceived: report.bytesReceived,
                        bytesSent: report.bytesSent,
                        requestsReceived: report.requestsReceived,
                        responsesReceived: report.responsesReceived,
                        localCandidateId: report.localCandidateId,
                        remoteCandidateId: report.remoteCandidateId,
                    }
                }
            })
            if (video?.codecId) {
                const entry: any = stats.get(video.codecId)
                if (entry) codec = { mimeType: entry.mimeType, clockRate: entry.clockRate, fmtp: entry.sdpFmtpLine }
            }
            if (pair?.localCandidateId) {
                const entry: any = stats.get(pair.localCandidateId)
                if (entry) localCandidate = { type: entry.candidateType, protocol: entry.protocol, relayProtocol: entry.relayProtocol, networkType: entry.networkType }
            }
            if (pair?.remoteCandidateId) {
                const entry: any = stats.get(pair.remoteCandidateId)
                if (entry) remoteCandidate = { type: entry.candidateType, protocol: entry.protocol, relayProtocol: entry.relayProtocol }
            }
        } catch (error) {
            this.stream?.sendClientLogMessage(`[Tesla AV ${elapsedMs}ms] getStats failed: ${String(error)}`)
            return
        }

        const canvas = this.canvasRenderer?.getWorkerDiagnostics() ?? null
        const audioPipeline = this.stream?.getAudioDiagnostics() ?? null
        const input = this.stream?.getInput()
        const now = performance.now()
        const intervalSeconds = Math.max(0.001, (now - this.lastDiagnosticAt) / 1000)
        const videoBytes = Number(video?.bytes ?? 0)
        const videoFrames = Number(video?.framesDecoded ?? 0)
        const audioPackets = Number(audioPipeline?.receivedPackets ?? 0)
        const canvasDrawn = Number((canvas as any)?.drawnFrameCount ?? 0)
        const decodedFrameDelta = Math.max(0, videoFrames - this.lastDiagnosticVideoFrames)
        const canvasDrawDelta = Math.max(0, canvasDrawn - this.lastDiagnosticCanvasDrawn)
        const deltas = {
            videoKbps: Math.round(Math.max(0, videoBytes - this.lastDiagnosticVideoBytes) * 8 / intervalSeconds / 1000),
            decodedFps: Number((decodedFrameDelta / intervalSeconds).toFixed(1)),
            canvasFps: Number((canvasDrawDelta / intervalSeconds).toFixed(1)),
            audioPackets: Math.max(0, audioPackets - this.lastDiagnosticAudioPackets),
        }
        this.lastDiagnosticAt = now
        this.lastDiagnosticVideoBytes = videoBytes
        this.lastDiagnosticVideoFrames = videoFrames
        this.lastDiagnosticAudioPackets = audioPackets
        this.lastDiagnosticCanvasDrawn = canvasDrawn
        const page = {
            visibility: document.visibilityState,
            online: navigator.onLine,
            focus: document.hasFocus(),
            trackState: this.latestVideoTrack?.readyState,
            trackMuted: this.latestVideoTrack?.muted,
            nativeReady: this.videoElement.readyState,
            nativeTime: Number(this.videoElement.currentTime.toFixed(2)),
            viewport: {
                inner: [window.innerWidth, window.innerHeight],
                document: [document.documentElement.clientWidth, document.documentElement.clientHeight],
                visual: window.visualViewport ? {
                    width: Number(window.visualViewport.width.toFixed(1)),
                    height: Number(window.visualViewport.height.toFixed(1)),
                    offsetLeft: Number(window.visualViewport.offsetLeft.toFixed(1)),
                    offsetTop: Number(window.visualViewport.offsetTop.toFixed(1)),
                    scale: Number(window.visualViewport.scale.toFixed(3)),
                } : null,
                screen: [window.screen.width, window.screen.height],
                available: [window.screen.availWidth, window.screen.availHeight],
                dpr: window.devicePixelRatio,
                teslaZoomCompensation: (window as typeof window & {
                    __teslaViewportMetrics?: unknown
                }).__teslaViewportMetrics ?? null,
                fullscreen: !!document.fullscreenElement,
                resolutionMode: getTeslaResolutionMode(),
                viewMode: getRemoteViewMode(),
                qualityMode: getTeslaQualityMode(),
                zoomLocked: this.viewZoomLocked,
                requestedStream: this.streamerSize,
            },
        }
        this.stream?.sendClientLogMessage(
            `[Tesla AV ${elapsedMs}ms] ice=${peer.iceConnectionState}/${peer.connectionState}; ` +
            `video=${JSON.stringify(video)}; audio=${JSON.stringify(audio)}; ` +
            `delta=${JSON.stringify(deltas)}; codec=${JSON.stringify(codec)}; ` +
            `canvas=${JSON.stringify(canvas)}; audioPipeline=${JSON.stringify(audioPipeline)}; ` +
            `input=${JSON.stringify({channels: input?.getChannelDiagnostics(), counters: input?.getInputDiagnostics()})}; ` +
            `pair=${JSON.stringify(pair)}; candidates=${JSON.stringify({local: localCandidate, remote: remoteCandidate})}; ` +
            `signal=${JSON.stringify(this.stream?.getSignalingDiagnostics())}; ` +
            `page=${JSON.stringify(page)}`
        )

        // Some Tesla Chromium builds decode the WebRTC track but expose no frames
        // through MediaStreamTrackProcessor. In that exact case, fall back to the
        // browser's native <video> pipeline instead of leaving a black canvas.
        const decoded = Number(video?.framesDecoded ?? 0)
        const drawn = canvasDrawn
        // Never leave Tesla with a black screen. Canvas remains preferred for
        // touch handling, but native video is a safety net when Chromium decodes
        // frames while MediaStreamTrackProcessor produces none.
        const allowNativeVideoFallback = true
        if (allowNativeVideoFallback && elapsedMs >= 3000 && decoded > 0 && drawn === 0) {
            this.enableNativeVideoFallback()
        } else if (allowNativeVideoFallback && decodedFrameDelta > 0 && canvasDrawDelta === 0) {
            this.consecutiveCanvasStalls++
            if (this.consecutiveCanvasStalls >= 2) {
                this.stream?.sendClientLogMessage(
                    "[Tesla AV] canvas stalled for two samples while WebRTC continued decoding"
                )
                this.enableNativeVideoFallback()
            }
        } else if (canvasDrawDelta > 0 || decodedFrameDelta === 0) {
            this.consecutiveCanvasStalls = 0
        }
    }

    private enableNativeVideoFallback() {
        if (this.nativeVideoFallbackEnabled || !this.latestVideoTrack) return
        this.nativeVideoFallbackEnabled = true
        this.cachedStreamRect = null
        this.videoElement.srcObject = new MediaStream([this.latestVideoTrack])
        this.videoElement.autoplay = true
        this.videoElement.style.pointerEvents = "none"
        this.videoElement.style.display = "block"
        this.canvasElement.style.display = "none"
        this.applyNativeVideoViewMode()
        void this.videoElement.play().catch(error => {
            this.stream?.sendClientLogMessage(`[Tesla AV] native video fallback play failed: ${String(error)}`)
        })
        this.stream?.sendClientLogMessage("[Tesla AV] enabled native video fallback (decoded frames, canvas drew none)")
    }

    private applyNativeVideoViewMode() {
        this.videoElement.classList.remove(
            "video-stream-stretched",
            "video-stream-fit-height",
            "video-stream-fit-width",
        )
        const mode = getRemoteViewMode()
        if (mode === "fit-height") {
            this.videoElement.classList.add("video-stream-fit-height")
        } else if (mode === "fit-width") {
            this.videoElement.classList.add("video-stream-fit-width")
        } else {
            this.videoElement.classList.add("video-stream-stretched")
        }
    }

    // Keyboard
    onKeyDown(event: KeyboardEvent) {
        this.onUserInteraction()

        if (event.ctrlKey && event.code == "KeyV") {
            // We are likely pasting -> don't send keys
        } else if (event.code == "F11") {
            // Allow manual fullscreen
        } else {
            event.preventDefault()
            this.stream?.getInput().onKeyDown(event)
        }

        event.stopPropagation()
    }

    private isTogglingFullscreenWithKeybind: "waitForCtrl" | "makingFullscreen" | "none" = "none"
    onKeyUp(event: KeyboardEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onKeyUp(event)
        event.stopPropagation()

        if (this.toggleFullscreenWithKeybind && this.isTogglingFullscreenWithKeybind == "none" && event.ctrlKey && event.shiftKey && event.code == "KeyI") {
            this.isTogglingFullscreenWithKeybind = "waitForCtrl"
        }
        if (this.isTogglingFullscreenWithKeybind == "waitForCtrl" && (event.code == "ControlRight" || event.code == "ControlLeft")) {
            this.isTogglingFullscreenWithKeybind = "makingFullscreen";

            (async () => {
                if (this.isFullscreen()) {
                    await this.exitPointerLock()
                    await this.exitFullscreen()
                } else {
                    await this.requestFullscreen()
                    await this.requestPointerLock()
                }

                this.isTogglingFullscreenWithKeybind = "none"
            })()
        }
    }

    onPaste(event: ClipboardEvent) {
        this.onUserInteraction()

        this.stream?.getInput().onPaste(event)

        event.stopPropagation()
    }

    // Mouse
    private reportFirstInputEvent(kind: string) {
        if (this.reportedInputKinds.has(kind)) return
        this.reportedInputKinds.add(kind)
        const channelStates = this.stream?.getInput().getChannelStates() ?? {}
        this.stream?.sendClientLogMessage(
            `[Tesla Input] first ${kind}; channels=${JSON.stringify(channelStates)}`
        )
    }

    onMouseButtonDown(event: MouseEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onMouseDown(event, this.getStreamRect());
        this.reportFirstInputEvent("mousedown")

        event.stopPropagation()
    }
    onMouseButtonUp(event: MouseEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onMouseUp(event)
        this.reportFirstInputEvent("mouseup")

        event.stopPropagation()
    }
    onMouseMove(event: MouseEvent) {
        event.preventDefault()
        this.stream?.getInput().onMouseMove(event, this.getStreamRect())
        this.reportFirstInputEvent("mousemove")

        event.stopPropagation()
    }
    onMouseWheel(event: WheelEvent) {
        event.preventDefault()
        this.stream?.getInput().onMouseWheel(event)

        event.stopPropagation()
    }
    onContextMenu(event: MouseEvent) {
        event.preventDefault()

        event.stopPropagation()
    }

    // Touch
    private twoTouchDistance(touches: TouchList): number | null {
        if (touches.length !== 2) return null
        const first = touches.item(0)
        const second = touches.item(1)
        if (!first || !second) return null
        return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)
    }

    private twoTouchCenter(touches: TouchList): [number, number] | null {
        if (touches.length !== 2) return null
        const first = touches.item(0)
        const second = touches.item(1)
        if (!first || !second) return null
        return [(first.clientX + second.clientX) / 2, (first.clientY + second.clientY) / 2]
    }

    private applyViewZoom(zoom: number, centerX: number = window.innerWidth / 2, centerY: number = window.innerHeight / 2) {
        this.viewZoom = Math.min(3, Math.max(0.75, zoom))
        const originX = Math.min(100, Math.max(0, centerX / Math.max(1, window.innerWidth) * 100))
        const originY = Math.min(100, Math.max(0, centerY / Math.max(1, window.innerHeight) * 100))

        if (Math.abs(this.viewZoom - 1) < 0.01) {
            this.viewZoom = 1
            this.canvasElement.style.transform = ""
            this.canvasElement.style.transformOrigin = ""
            this.videoElement.style.transform = ""
            this.videoElement.style.transformOrigin = ""
        } else {
            const origin = `${originX.toFixed(1)}% ${originY.toFixed(1)}%`
            this.canvasElement.style.transformOrigin = origin
            this.canvasElement.style.transform = `scale(${this.viewZoom})`
            this.videoElement.style.transformOrigin = origin
            this.videoElement.style.transform = `translate(-50%, -50%) scale(${this.viewZoom})`
        }

        // Input uses the transformed surface rectangle, so discard the old
        // cached mapping whenever pinch zoom changes.
        this.cachedStreamRect = null
    }

    resetViewZoom() {
        this.applyViewZoom(1)
        this.stream?.sendClientLogMessage("[Tesla Zoom] reset to 100%")
    }

    isViewZoomLocked(): boolean {
        return this.viewZoomLocked
    }

    setViewZoomLocked(locked: boolean) {
        this.viewZoomLocked = locked
        setTeslaZoomLocked(locked)
        this.pinchStartDistance = null
        this.pinchActive = false
        this.pinchLogStarted = false
        if (locked) this.resetViewZoom()
        this.stream?.sendClientLogMessage(`[Tesla Zoom] ${locked ? "locked" : "unlocked"}`)
    }

    async applyDisplayMode(mode: TeslaResolutionMode): Promise<void> {
        await apiSetDisplayPreset(this.api, displayPresetForMode(mode), false, getTeslaStreamSize(mode, getBrowserViewportSize()))
    }

    onTouchStart(event: TouchEvent) {
        this.onUserInteraction()

        event.preventDefault()
        const distance = this.twoTouchDistance(event.touches)
        if (!this.viewZoomLocked && distance != null) {
            this.pinchStartDistance = distance
            this.pinchStartZoom = this.viewZoom
            this.pinchActive = false
            this.pinchLogStarted = false
        }
        this.stream?.getInput().onTouchStart(event, this.getStreamRect())
        this.reportFirstInputEvent("touchstart")
        this.ensurePollLoopRunning()

        event.stopPropagation()
    }
    onTouchEnd(event: TouchEvent) {
        this.onUserInteraction()

        event.preventDefault()
        if (this.pinchActive) {
            // Clear the input tracker's two-finger scroll state without
            // producing a click when a pinch finishes.
            this.stream?.getInput().onTouchCancel(event, this.getStreamRect())
            this.stream?.sendClientLogMessage(`[Tesla Zoom] finished at ${Math.round(this.viewZoom * 100)}%`)
        } else {
            this.stream?.getInput().onTouchEnd(event, this.getStreamRect())
        }
        if (event.touches.length < 2) {
            this.pinchStartDistance = null
            this.pinchActive = false
            this.pinchLogStarted = false
        }
        this.reportFirstInputEvent("touchend")
        this.ensurePollLoopRunning()

        event.stopPropagation()
    }
    onTouchCancel(event: TouchEvent) {
        this.onUserInteraction()

        event?.preventDefault()
        this.stream?.getInput().onTouchCancel(event, this.getStreamRect())
        this.pinchStartDistance = null
        this.pinchActive = false
        this.pinchLogStarted = false
        this.reportFirstInputEvent("touchcancel")
        this.ensurePollLoopRunning()

        event.stopPropagation()
    }
    onTouchUpdate() {
        this.stream?.getInput().onTouchUpdate(this.getStreamRect())
    }
    onTouchMove(event: TouchEvent) {
        event.preventDefault()

        const distance = this.twoTouchDistance(event.touches)
        if (!this.viewZoomLocked && distance != null && this.pinchStartDistance != null && this.pinchStartDistance > 0) {
            const ratio = distance / this.pinchStartDistance
            // Parallel two-finger motion remains scrolling. A clear change in
            // finger separation switches the gesture to local view zoom.
            if (this.pinchActive || Math.abs(ratio - 1) >= 0.08) {
                this.pinchActive = true
                const center = this.twoTouchCenter(event.touches)
                if (center) {
                    this.applyViewZoom(this.pinchStartZoom * ratio, center[0], center[1])
                }
                if (!this.pinchLogStarted) {
                    this.pinchLogStarted = true
                    this.stream?.sendClientLogMessage("[Tesla Zoom] pinch started")
                }
                this.reportFirstInputEvent("pinchzoom")
                event.stopPropagation()
                return
            }
        }

        this.stream?.getInput().onTouchMove(event, this.getStreamRect())
        this.reportFirstInputEvent("touchmove")

        event.stopPropagation()
    }

    // Gamepad
    onGamepadConnect(event: GamepadEvent) {
        this.onGamepadAdd(event.gamepad)
    }
    onGamepadAdd(gamepad: Gamepad) {
        // YouTube uses the fixed shortcut mapping below. Do not also forward
        // a native virtual gamepad to Sunshine or one press can act twice.
        if (!this.isYoutubeRemote) this.stream?.getInput().onGamepadConnect(gamepad)
        this.sidebar.setControllerStatus(gamepad)
        this.ensurePollLoopRunning()
    }
    onGamepadDisconnect(event: GamepadEvent) {
        if (!this.isYoutubeRemote) this.stream?.getInput().onGamepadDisconnect(event)
        this.controllerPreviousButtons.delete(event.gamepad.index)
        this.controllerPreviousDirections.delete(event.gamepad.index)
        this.releaseControllerKeyboardKeys()
        this.sidebar.setControllerStatus(null)
        this.ensurePollLoopRunning()
    }
    onGamepadUpdate() {
        if (this.isYoutubeRemote) {
            this.handleTeslaController()
            return
        }
        this.stream?.getInput().onGamepadUpdate()
    }

    private releaseControllerKeyboardKeys() {
        const input = this.stream?.getInput()
        for (const key of this.controllerKeyboardDown) input?.sendKey(false, key, 0)
        this.controllerKeyboardDown.clear()
    }

    private controllerDirectionPressed(
        gamepad: Gamepad,
        name: "up" | "down" | "left" | "right",
    ): boolean {
        if (name === "up") return !!gamepad.buttons[12]?.pressed || (gamepad.axes[1] ?? 0) < -0.55
        if (name === "down") return !!gamepad.buttons[13]?.pressed || (gamepad.axes[1] ?? 0) > 0.55
        if (name === "left") return !!gamepad.buttons[14]?.pressed || (gamepad.axes[0] ?? 0) < -0.55
        return !!gamepad.buttons[15]?.pressed || (gamepad.axes[0] ?? 0) > 0.55
    }

    private runControllerYoutubeAction(action: YoutubeControlAction, repeatable: boolean, pressed: boolean, wasPressed: boolean) {
        if (!pressed) {
            this.controllerRepeatAt.delete(action)
            return
        }
        const now = performance.now()
        const nextAt = this.controllerRepeatAt.get(action) ?? 0
        if (!wasPressed || (repeatable && now >= nextAt)) {
            void this.controlYoutube(action).catch(error => console.warn("PS4 YouTube control failed", error))
            this.controllerRepeatAt.set(action, now + (wasPressed ? 150 : 420))
        }
    }

    private handleTeslaController() {
        const gamepad = Array.from(navigator.getGamepads()).find(candidate => candidate?.connected) ?? null
        if (!gamepad) {
            this.releaseControllerKeyboardKeys()
            return
        }

        const now = performance.now()
        if (now - this.controllerStatusUpdatedAt > 500) {
            this.controllerStatusUpdatedAt = now
            this.sidebar.setControllerStatus(gamepad)
        }

        const previousButtons = this.controllerPreviousButtons.get(gamepad.index) ?? []
        const pressed = (index: number) => !!gamepad.buttons[index]?.pressed
        const justPressed = (index: number) => pressed(index) && !previousButtons[index]
        const directions = {
            up: this.controllerDirectionPressed(gamepad, "up"),
            down: this.controllerDirectionPressed(gamepad, "down"),
            left: this.controllerDirectionPressed(gamepad, "left"),
            right: this.controllerDirectionPressed(gamepad, "right"),
        }
        const previousDirections = this.controllerPreviousDirections.get(gamepad.index)
            ?? { up: false, down: false, left: false, right: false }

        // One fixed PS4 mapping for YouTube. Directional movement uses the
        // page's reliable three-column focus navigator; every face/shoulder
        // button maps to the matching standard YouTube keyboard shortcut.
        this.releaseControllerKeyboardKeys()
        this.runControllerYoutubeAction("focus_up", true, directions.up, previousDirections.up)
        this.runControllerYoutubeAction("focus_down", true, directions.down, previousDirections.down)
        this.runControllerYoutubeAction("focus_left", true, directions.left, previousDirections.left)
        this.runControllerYoutubeAction("focus_right", true, directions.right, previousDirections.right)
        if (justPressed(0)) void this.controlYoutube("select")       // Cross = Enter
        if (justPressed(1)) void this.controlYoutube("back")         // Circle = Escape/back
        if (justPressed(2)) void this.controlYoutube("play_pause")   // Square = Space/K
        if (justPressed(3)) void this.controlYoutube("fullscreen")   // Triangle = F
        if (justPressed(4)) void this.controlYoutube("seek_back")    // L1 = J
        if (justPressed(5)) void this.controlYoutube("seek_forward") // R1 = L
        if (justPressed(6)) void this.controlYoutube("volume_down")  // L2
        if (justPressed(7)) void this.controlYoutube("volume_up")    // R2
        if (justPressed(8)) void this.controlYoutube("captions")     // Share
        if (justPressed(9)) void this.controlYoutube("home")         // Options
        if (justPressed(10)) void this.controlYoutube("mute")        // L3
        if (justPressed(11)) toggleSidebar()                          // R3 = show/hide Sunshine menu

        this.controllerPreviousButtons.set(gamepad.index, gamepad.buttons.map(button => button.pressed))
        this.controllerPreviousDirections.set(gamepad.index, directions)
    }

    private shouldPollInputs(): boolean {
        const input = this.stream?.getInput()
        if (!input) return false
        const hasYoutubeController = this.isYoutubeRemote
            && Array.from(navigator.getGamepads()).some(gamepad => gamepad?.connected)
        return input.hasPrimaryTouch() || input.hasGamepads() || hasYoutubeController
    }

    private ensurePollLoopRunning() {
        if (this.pollLoopRunning || !this.shouldPollInputs()) {
            return
        }

        this.pollLoopRunning = true
        const pollLoop = () => {
            const input = this.stream?.getInput()
            if (!input) {
                this.pollLoopRunning = false
                this.pollRafId = null
                this.pollTimerId = null
                return
            }

            const hasPrimaryTouch = input.hasPrimaryTouch()

            if (hasPrimaryTouch) {
                this.onTouchUpdate()
            }

            // Poll gamepads every rAF (full 60Hz). Previously throttled to
            // 30Hz on the assumption that navigator.getGamepads() was
            // expensive (~100μs+) on Tesla — but field instrumentation
            // (2026-07-07) measured actual call times of ~0.2ms typical,
            // <2.5ms worst case even during active play, with zero
            // correlation to the freezes we were chasing (which turned out to
            // be a bitrate/CPU-budget issue, unrelated to input polling — see
            // gaming preset bitrate cap). That's negligible within a 16.6ms
            // frame budget, so there's no reason to leave latency on the
            // table: this halves worst-case gamepad input latency from ~33ms
            // to ~16ms.
            const hasYoutubeController = this.isYoutubeRemote
                && Array.from(navigator.getGamepads()).some(gamepad => gamepad?.connected)
            if (input.hasGamepads() || hasYoutubeController) {
                this.onGamepadUpdate()
            }

            if (!this.shouldPollInputs()) {
                this.pollLoopRunning = false
                this.pollRafId = null
                this.pollTimerId = null
                return
            }

            // Always use rAF for both touch and gamepad polling.
            // This syncs input sampling with the display refresh (~16.6ms at 60Hz),
            // reducing input latency from 50ms to ~16ms for gamepads while keeping
            // touch tracking smooth. navigator.getGamepads() allocates a new array
            // each call but at 60Hz the GC pressure is negligible.
            this.pollRafId = requestAnimationFrame(pollLoop)
            this.pollTimerId = null
        }

        this.pollRafId = requestAnimationFrame(pollLoop)
        this.pollTimerId = null
    }

    // Fullscreen
    async requestFullscreen() {
        const body = document.body
        if (body) {
            if (!("requestFullscreen" in body && typeof body.requestFullscreen == "function")) {
                await showMessage("Fullscreen is not supported by your browser!")

                return
            }

            this.focusInput()

            if (!this.isFullscreen()) {
                try {
                    await body.requestFullscreen({
                        navigationUI: "hide"
                    })
                } catch (e) {
                    console.warn("failed to request fullscreen", e)
                }
            }

            try {
                await requestKeyboardLock()

                if (!this.hasShownFullscreenEscapeWarning) {
                    await showMessage("To exit Fullscreen you'll have to hold ESC for a few seconds.")
                }
                this.hasShownFullscreenEscapeWarning = true
            } catch (e) {
                console.warn("Keyboard lock failed", e)
            }

            if (this.getStream()?.getInput().getConfig().mouseMode == "relative") {
                await this.requestPointerLock()
            }

            try {
                if (screen && "orientation" in screen) {
                    const orientation = screen.orientation

                    if ("lock" in orientation && typeof orientation.lock == "function") {
                        await orientation.lock("landscape")
                    }
                }
            } catch (e) {
                console.warn("failed to set orientation to landscape", e)
            }
        } else {
            console.warn("root element not found")
        }
    }
    async exitFullscreen() {
        if ("keyboard" in navigator && navigator.keyboard && "unlock" in navigator.keyboard) {
            await navigator.keyboard.unlock()
        }

        if ("exitFullscreen" in document && typeof document.exitFullscreen == "function") {
            await document.exitFullscreen()
        }
    }
    isFullscreen(): boolean {
        return "fullscreenElement" in document && !!document.fullscreenElement
    }
    toggleStats() {
        if (this.statsOverlay.isVisible()) {
            this.statsOverlay.hide()
        } else {
            this.statsOverlay.show()
        }
    }
    private async onFullscreenChange() {
        this.cachedStreamRect = null
        this.checkFullyImmersed()
    }

    // Pointer Lock
    async requestPointerLock(errorIfNotFound: boolean = false) {
        this.previousMouseMode = this.inputConfig.mouseMode

        const inputElement = document.getElementById("input") as HTMLDivElement

        if (inputElement && "requestPointerLock" in inputElement && typeof inputElement.requestPointerLock == "function") {
            this.focusInput()

            this.inputConfig.mouseMode = "relative"
            this.setInputConfig(this.inputConfig)

            setSidebarExtended(false)

            const onLockError = () => {
                document.removeEventListener("pointerlockerror", onLockError)

                // Fallback: try to request pointer lock without options
                inputElement.requestPointerLock()
            }

            document.addEventListener("pointerlockerror", onLockError, { once: true })

            try {
                let promise = inputElement.requestPointerLock({
                    unadjustedMovement: true
                })

                if (promise) {
                    await promise
                } else {
                    inputElement.requestPointerLock()
                }
            } catch (error) {
                // Some platforms do not support unadjusted movement. If you
                // would like PointerLock anyway, request again.
                if (error instanceof Error && error.name == "NotSupportedError") {
                    inputElement.requestPointerLock()
                } else {
                    throw error
                }
            } finally {
                document.removeEventListener("pointerlockerror", onLockError)
            }

        } else if (errorIfNotFound) {
            await showMessage("Pointer Lock not supported")
        }
    }
    async exitPointerLock() {
        if ("exitPointerLock" in document && typeof document.exitPointerLock == "function") {
            document.exitPointerLock()
        }
    }
    private onPointerLockChange() {
        this.checkFullyImmersed()

        if (!document.pointerLockElement) {
            this.inputConfig.mouseMode = this.previousMouseMode
            this.setInputConfig(this.inputConfig)
        }
    }

    // -- Fully immersed Fullscreen -> Fullscreen API + Pointer Lock
    private checkFullyImmersed() {
        if ("pointerLockElement" in document && document.pointerLockElement &&
            "fullscreenElement" in document && document.fullscreenElement) {
            // We're fully immersed -> remove sidebar
            setSidebar(null)
        } else {
            setSidebar(this.sidebar)
        }
    }


    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
    }

    getStreamRect(): DOMRect {
        if (this.cachedStreamRect) return this.cachedStreamRect

        // The bounding rect of the videoElement or canvasElement can be bigger than the actual video
        // -> We need to correct for this when sending positions, else positions are wrong

        const videoSize = this.stream?.getStreamerSize() ?? this.streamerSize
        const videoAspect = videoSize[0] / videoSize[1]

        const useNativeVideoSurface = !this.settings?.canvasRenderer || this.nativeVideoFallbackEnabled
        if(useNativeVideoSurface) {
            const boundingRect = this.videoElement.getBoundingClientRect()

            if (this.settings?.stretchToFit) {
                // Stretched: the entire bounding rect is the input surface
                this.cachedStreamRect = boundingRect
                return this.cachedStreamRect
            }

            // Use the video element's actual intrinsic dimensions when available.
            // Before the video plays, videoWidth/videoHeight are 0 and the CSS box
            // is forced to min-width/min-height (potentially a square), which would
            // produce a wrong rect. Don't cache in that case.
            const intrinsicW = this.videoElement.videoWidth
            const intrinsicH = this.videoElement.videoHeight
            const effectiveSize: [number, number] = (intrinsicW > 0 && intrinsicH > 0)
                ? [intrinsicW, intrinsicH]
                : videoSize
            const effectiveAspect = effectiveSize[0] / effectiveSize[1]
            const boundingRectAspect = boundingRect.width / boundingRect.height

            let x = boundingRect.x
            let y = boundingRect.y
            let videoMultiplier
            if (boundingRectAspect > effectiveAspect) {
                // How much is the video scaled up
                videoMultiplier = boundingRect.height / effectiveSize[1]

                // Note: Both in boundingRect / page scale
                const boundingRectHalfWidth = boundingRect.width / 2
                const videoHalfWidth = effectiveSize[0] * videoMultiplier / 2

                x += boundingRectHalfWidth - videoHalfWidth
            } else {
                // Same as above but inverted
                videoMultiplier = boundingRect.width / effectiveSize[0]

                const boundingRectHalfHeight = boundingRect.height / 2
                const videoHalfHeight = effectiveSize[1] * videoMultiplier / 2

                y += boundingRectHalfHeight - videoHalfHeight
            }

            const rect = new DOMRect(
                x,
                y,
                effectiveSize[0] * videoMultiplier,
                effectiveSize[1] * videoMultiplier
            )
            // Only cache once we have real intrinsic dimensions; otherwise the video
            // element is still at its pre-load size and we'd cache a wrong rect.
            if (intrinsicW > 0) {
                this.cachedStreamRect = rect
            }
            return rect
        }
        else {
            const clientRect = this.canvasElement.getBoundingClientRect()
            
            const canvasCssWidth = clientRect.width
            const canvasCssHeight = clientRect.height

            const boundingRectAspect = canvasCssWidth / canvasCssHeight
            let x = clientRect.x
            let y = clientRect.y
            let width = canvasCssWidth
            let height = canvasCssHeight
            let videoMultiplier

            if (this.settings?.stretchToFit) {
                // If stretched, the input rect is simply the canvas's client rect
                this.cachedStreamRect = clientRect
                return this.cachedStreamRect
            } else if (boundingRectAspect > videoAspect) {
                // Canvas is wider than video aspect, video will be pillarboxed
                videoMultiplier = canvasCssHeight / videoSize[1]
                const videoRenderedWidth = videoSize[0] * videoMultiplier
                x += (canvasCssWidth - videoRenderedWidth) / 2 // Center horizontally
                width = videoRenderedWidth
            }
            else {
                // Canvas is taller than video aspect, video will be letterboxed
                videoMultiplier = canvasCssWidth / videoSize[0]
                const videoRenderedHeight = videoSize[1] * videoMultiplier
                y += (canvasCssHeight - videoRenderedHeight) / 2 // Center vertically
                height = videoRenderedHeight
            }
            this.cachedStreamRect = new DOMRect(x, y, width, height)
            return this.cachedStreamRect
        }
    }
    getElement(): HTMLElement {
        return (!this.settings?.canvasRenderer || this.nativeVideoFallbackEnabled)
            ? this.videoElement
            : this.canvasElement
    }
    getStream(): Stream | null {
        return this.stream
    }

    async controlYoutube(action: YoutubeControlAction, query?: string): Promise<YoutubeControlResponse> {
        return await apiYoutubeControl(this.api, action, query)
    }

    async exitRemoteApp(): Promise<void> {
        try {
            await apiHostCancel(this.api, { host_id: this.hostId })
        } catch (error) {
            // Returning to the launcher is still useful if Sunshine has already
            // ended the session or the cancel request races with disconnect.
            console.warn("Could not explicitly cancel remote app", error)
        } finally {
            window.location.href = window.location.origin + "/"
        }
    }

    async controlUb1818(action: Ub1818ControlAction): Promise<Ub1818ControlResponse> {
        return await apiUb1818Control(this.api, action)
    }

    setBrightness(value: number) {
        // value = 0 (no effect) to 1 (max shadow boost)
        this.shadowBoost = Math.min(1, Math.max(0, value))
        try { localStorage.setItem('mlShadowBoost', String(this.shadowBoost)) } catch (_) {}
        this.applyVideoFilters()
    }

    setScreenBrightness(value: number) {
        this.screenBrightness = Math.min(50, Math.max(-50, Math.round(value)))
        setScreenBrightness(this.screenBrightness)
        this.applyVideoFilters()
    }

    getScreenBrightness(): number {
        return this.screenBrightness
    }

    private applyVideoFilters() {
        if (!this.shadowBoostSvg) this.setupShadowBoostFilter()
        const boost = this.shadowBoost
        const exponent = 1 - boost * 0.7  // 0 -> 1.0 (linear), 1 -> 0.3 (strong lift)
        for (const fn of this.shadowBoostFuncs) {
            fn.setAttribute('exponent', String(exponent))
        }
        const saturation = 1 + boost * 0.6
        const brightness = 1 + this.screenBrightness / 100
        const parts: string[] = []
        if (this.screenBrightness !== 0) parts.push(`brightness(${brightness})`)
        if (boost !== 0) parts.push(`url(#ml-shadow-filter) saturate(${saturation})`)
        const filterStr = parts.join(" ")
        this.canvasElement.style.filter = filterStr
        this.videoElement.style.filter = filterStr
    }

    private shadowBoostSvg: SVGSVGElement | null = null
    private shadowBoostFuncs: Element[] = []
    private setupShadowBoostFilter() {
        const ns = 'http://www.w3.org/2000/svg'
        const svg = document.createElementNS(ns, 'svg') as SVGSVGElement
        svg.style.cssText = 'display:none;position:absolute;'
        const filter = document.createElementNS(ns, 'filter')
        filter.id = 'ml-shadow-filter'
        filter.setAttribute('color-interpolation-filters', 'sRGB')
        const transfer = document.createElementNS(ns, 'feComponentTransfer')
        const funcs: Element[] = []
        for (const ch of ['R', 'G', 'B']) {
            const fn = document.createElementNS(ns, `feFunc${ch}`)
            fn.setAttribute('type', 'gamma')
            fn.setAttribute('amplitude', '1')
            fn.setAttribute('exponent', '1')
            fn.setAttribute('offset', '0')
            transfer.appendChild(fn)
            funcs.push(fn)
        }
        filter.appendChild(transfer)
        svg.appendChild(filter)
        document.body.appendChild(svg)
        this.shadowBoostSvg = svg
        this.shadowBoostFuncs = funcs
    }

    getBrightness(): number {
        return this.shadowBoost
    }
}

class ConnectionInfoModal implements Modal<void> {

    private eventTarget = new EventTarget()

    private root = document.createElement("div")

    private text = document.createElement("p")

    private debugDetailButton = document.createElement("button")
    private debugDetailRetryButton = document.createElement("button")
    private authFailed = false
    private debugDetail = "" // We store this seperate because line breaks don't work when the element is not mounted on the dom
    private debugDetailDisplay = document.createElement("div")

    constructor() {
        this.root.classList.add("modal-video-connect")

        this.text.innerText = "Connecting"
        this.root.appendChild(this.text)

        this.debugDetailButton.innerText = "Show Logs"
        this.debugDetailButton.addEventListener("click", this.onDebugDetailClick.bind(this))
        this.root.appendChild(this.debugDetailButton)

        this.debugDetailRetryButton.innerText = "Retry"
        this.debugDetailRetryButton.style.display = "none"
        this.debugDetailRetryButton.addEventListener("click", this.onDebugDetailRetryClick.bind(this))
        this.root.appendChild(this.debugDetailRetryButton)

        this.debugDetailDisplay.classList.add("textlike")
        this.debugDetailDisplay.classList.add("modal-video-connect-debug")
    }

    private onDebugDetailClick() {
        let debugDetailCurrentlyShown = this.root.contains(this.debugDetailDisplay)

        if (debugDetailCurrentlyShown) {
            this.debugDetailButton.innerText = "Show Logs"
            this.root.removeChild(this.debugDetailDisplay)
        } else {
            this.debugDetailButton.innerText = "Hide Logs"
            this.root.appendChild(this.debugDetailDisplay)
            this.debugDetailDisplay.innerText = this.debugDetail
        }
    }

    private onDebugDetailRetryClick() {
        if (this.authFailed) {
            logout()
            window.location.href = window.location.origin + "/"
        } else {
            window.location.reload()
        }
    }

    private debugLog(line: string) {
        this.debugDetail += `${line}\n`
        this.debugDetailDisplay.innerText = this.debugDetail
        console.info(`[Stream]: ${line}`)
    }

    onInfo(event: InfoEvent) {
        const data = event.detail

        if (data.type == "stageStarting") {
            const text = `Server: Starting Stage: ${data.stage}`
            this.text.innerText = text
            this.debugLog(text)
        } else if (data.type == "stageComplete") {
            const text = `Server: Completed Stage: ${data.stage}`
            this.text.innerText = text
            this.debugLog(text)
        } else if (data.type == "stageFailed") {
            const text = `Server: Failed Stage: ${data.stage} with error ${data.errorCode}`
            this.debugLog(text)
            if (data.stage === "Authentication") {
                this.authFailed = true
                this.text.innerText = "Authentication failed. Please log in again."
                this.debugDetailRetryButton.innerText = "Login Again"
                this.debugDetailRetryButton.style.display = "inline-block"
                showModal(this)
            } else {
                this.text.innerText = text
            }
        } else if (data.type == "connectionComplete") {
            const text = `Connection Complete`
            this.text.innerText = text
            this.debugLog(text)

            this.eventTarget.dispatchEvent(new Event("ml-connected"))
        } else if (data.type == "addDebugLine") {
            this.debugLog(data.line)
        }
        // Reopen the modal cause we might already be closed at this point
        else if (data.type == "connectionTerminated") {
            const text = `Server: Connection Terminated with code ${data.errorCode}`
            this.text.innerText = text
            this.debugLog(text)
            this.debugDetailRetryButton.style.display = "inline-block"
            showModal(this)
        } else if (data.type == "error") {
            const text = `Server: Error: ${data.message}`
            this.text.innerText = text
            this.debugLog(text)
            this.debugDetailRetryButton.style.display = "inline-block"
            showModal(this)
        } else if (data.type == "connectionRecovered") {
            this.debugLog("Connection recovered")
            this.debugDetailRetryButton.style.display = "none"
            // Resolve the modal's onFinish promise to auto-dismiss
            this.eventTarget.dispatchEvent(new Event("ml-connected"))
        }
    }

    onFinish(abort: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            this.eventTarget.addEventListener("ml-connected", () => resolve(), { once: true, signal: abort })
        })
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.root)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.root)
    }
}

class ViewerSidebar implements Component, Sidebar {
    private app: ViewerApp
    private buildTag = getBuildVersionTag()
    private isYoutubeRemote: boolean
    private isUb1818Remote: boolean
    private isTouchRemote: boolean

    private div = document.createElement("div")

    private buttonDiv = document.createElement("div")

    private sendKeycodeButton = document.createElement("button")

    private keyboardButton = document.createElement("button")
    private floatingKeyboardButton = document.createElement("button")
    private screenKeyboard = new ScreenKeyboard()

    private lockMouseButton = document.createElement("button")
    private fullscreenButton = document.createElement("button")
    private zoomLockButton = document.createElement("button")
    private brightnessSlider = document.createElement("input")
    private brightnessLabel = document.createElement("label")
    private inputClientsIndicator = document.createElement("div")
    private youtubeStatus = document.createElement("div")
    private youtubePlayButton: HTMLButtonElement | null = null
    private youtubeMuteButton: HTMLButtonElement | null = null
    private youtubeControllerHelp: HTMLElement | null = null

    private mouseMode: SelectComponent | null = null
    private touchMode: SelectComponent | null = null

    constructor(app: ViewerApp, isYoutubeRemote: boolean, isUb1818Remote: boolean) {
        this.app = app
        this.isYoutubeRemote = isYoutubeRemote
        this.isUb1818Remote = isUb1818Remote
        this.isTouchRemote = isYoutubeRemote || isUb1818Remote

        // Configure divs
        this.div.classList.add("sidebar-stream")

        this.buttonDiv.classList.add("sidebar-stream-buttons")
        if (this.isTouchRemote) {
            getSidebarRoot()?.classList.add("sidebar-youtube-active")
            applyYoutubeMenuOpacity(getYoutubeMenuOpacity())
            this.div.classList.add("sidebar-youtube-mode")
            this.div.appendChild(this.isYoutubeRemote
                ? this.buildYoutubeControls()
                : this.buildUb1818Controls())

            const advanced = document.createElement("details")
            advanced.classList.add("youtube-stream-advanced")
            const summary = document.createElement("summary")
            summary.innerText = "Stream & input settings"
            advanced.appendChild(summary)
            advanced.appendChild(this.buttonDiv)
            this.div.appendChild(advanced)
        } else {
            getSidebarRoot()?.classList.remove("sidebar-youtube-active")
            this.div.appendChild(this.buttonDiv)
        }

        // Send keycode
        this.sendKeycodeButton.innerText = "Send Keycode"
        this.sendKeycodeButton.addEventListener("click", async () => {
            const key = await showModal(new SendKeycodeModal())

            if (key == null) {
                return
            }

            this.app.getStream()?.getInput().sendKey(true, key, 0)
            this.app.getStream()?.getInput().sendKey(false, key, 0)
        })
        if (!this.isTouchRemote) this.buttonDiv.appendChild(this.sendKeycodeButton)

        // Pointer Lock
        this.lockMouseButton.innerText = "Lock Mouse"
        this.lockMouseButton.addEventListener("click", async () => {
            await this.app.requestPointerLock(true)
        })
        if (!this.isTouchRemote) this.buttonDiv.appendChild(this.lockMouseButton)

        // Pop up keyboard
        this.keyboardButton.innerText = this.isUb1818Remote ? "⌨ Keyboard" : "Keyboard"
        this.keyboardButton.addEventListener("click", async () => {
            setSidebarExtended(false)
            this.screenKeyboard.show()
        })
        // UB1818 keeps its keyboard in the everyday touch controls below. Do
        // not move it into the collapsed advanced panel after buildUb1818Controls
        // has already mounted it there.
        if (!this.isUb1818Remote) this.buttonDiv.appendChild(this.keyboardButton)

        this.floatingKeyboardButton.innerText = "\u2328\u00d7"
        this.floatingKeyboardButton.title = "Hide Keyboard"
        this.floatingKeyboardButton.style.cssText = "position:fixed;top:50%;right:12px;transform:translateY(-50%);width:44px;height:44px;z-index:1000;display:none;align-items:center;justify-content:center;border:1px solid rgba(100,200,255,0.6);border-radius:999px;background:rgba(0,0,0,0.55);color:white;font-size:18px;opacity:0.78;cursor:pointer;"
        const hideKeyboard = (event: Event) => {
            event.preventDefault()
            event.stopPropagation()
            this.screenKeyboard.hide()
            this.floatingKeyboardButton.style.display = "none"
        }
        this.floatingKeyboardButton.addEventListener("click", hideKeyboard)
        this.floatingKeyboardButton.addEventListener("touchend", hideKeyboard)
        // The stream listens on document. Consume the *whole* button gesture,
        // not only touchend, or StreamInput retains a phantom active finger.
        stopPropagationOn(this.floatingKeyboardButton)

        this.screenKeyboard.addKeyDownListener(this.onKeyDown.bind(this))
        this.screenKeyboard.addKeyUpListener(this.onKeyUp.bind(this))
        this.screenKeyboard.addTextListener(this.onText.bind(this))
        this.screenKeyboard.addKeyboardModeListener(this.onKeyboardModeChange.bind(this))
        this.div.appendChild(this.screenKeyboard.getHiddenElement())


        // Fullscreen
        this.fullscreenButton.innerText = "Fullscreen"
        this.fullscreenButton.addEventListener("click", async () => {
            if (this.app.isFullscreen()) {
                await this.app.exitFullscreen()
            } else {
                await this.app.requestFullscreen()
            }
        })
        this.buttonDiv.appendChild(this.fullscreenButton)

        this.buttonDiv.appendChild(this.buildSegmentedSetting(
            "View",
            getRemoteViewMode(),
            [
                { value: "fit-height", label: "Height", title: "Show the top and bottom edges" },
                { value: "fit-width", label: "Width", title: "Show the left and right edges" },
                { value: "fill", label: "Fill", title: "Stretch the stream to fill the browser" },
            ],
            (value) => {
                setRemoteViewMode(value as RemoteViewMode)
                reloadStreamKeepingDisplay()
            },
        ))

        // A GameStream session negotiates resolution only at start, so a new
        // selection applies the matching stream preset and then reloads.
        this.buttonDiv.appendChild(this.buildSegmentedSetting(
            "Resolution",
            getTeslaResolutionMode(),
            [
                { value: "windowed", label: "Window", title: "1600 × 1200 Tesla window" },
                { value: "fullscreen", label: "Full", title: "1920 × 1080 fullscreen" },
                { value: "auto", label: "Auto", title: "Follow the current browser viewport" },
            ],
            async (value) => {
                const mode = value as TeslaResolutionMode
                try {
                    await this.app.applyDisplayMode(mode)
                    setTeslaResolutionMode(mode)
                    reloadStreamKeepingDisplay()
                } catch (error) {
                    showErrorPopup(`Could not change the display preset: ${String(error)}`)
                    throw error
                }
            },
        ))

        this.buttonDiv.appendChild(this.buildSegmentedSetting(
            "Quality",
            getTeslaQualityMode(),
            [
                { value: "reliable", label: "Reliable", title: "Lower bitrate for weaker connections" },
                { value: "high", label: "High", title: "Balanced quality and latency" },
                { value: "ultra", label: "Ultra", title: "Highest bitrate for strong connections" },
            ],
            (value) => {
                setTeslaQualityMode(value as TeslaQualityMode)
                reloadStreamKeepingDisplay()
            },
        ))

        const updateZoomLockLabel = () => {
            this.zoomLockButton.innerText = this.app.isViewZoomLocked()
                ? "Zoom: Locked · 2-finger scroll"
                : "Zoom: Unlocked · pinch enabled"
        }
        updateZoomLockLabel()
        this.zoomLockButton.addEventListener("click", () => {
            this.app.setViewZoomLocked(!this.app.isViewZoomLocked())
            updateZoomLockLabel()
        })
        this.buttonDiv.appendChild(this.zoomLockButton)

        const resetZoomButton = document.createElement("button")
        resetZoomButton.innerText = "Reset Zoom (100%)"
        resetZoomButton.addEventListener("click", () => {
            this.app.resetViewZoom()
            setSidebarExtended(false)
        })
        this.buttonDiv.appendChild(resetZoomButton)

        // Shadow Boost slider
        const initialBrightness = this.app.getBrightness()
        this.app.setBrightness(initialBrightness) // apply persisted value immediately

        const brightnessWrapper = document.createElement("div")
        brightnessWrapper.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:4px 0;"

        const pct = Math.round(initialBrightness * 100)
        this.brightnessLabel.innerText = `Shadow Boost: ${pct === 0 ? 'Off' : pct + '%'}`
        this.brightnessLabel.style.cssText = "font-size:13px;color:#ccc;user-select:none;"

        this.brightnessSlider.type = "range"
        this.brightnessSlider.min = "0"
        this.brightnessSlider.max = "1"
        this.brightnessSlider.step = "0.05"
        this.brightnessSlider.value = String(initialBrightness)
        this.brightnessSlider.style.cssText = "width:100%;cursor:pointer;"
        this.brightnessSlider.addEventListener("input", () => {
            const v = parseFloat(this.brightnessSlider.value)
            const p = Math.round(v * 100)
            this.brightnessLabel.innerText = `Shadow Boost: ${p === 0 ? 'Off' : p + '%'}`
            this.app.setBrightness(v)
        })

        brightnessWrapper.appendChild(this.brightnessLabel)
        brightnessWrapper.appendChild(this.brightnessSlider)
        this.buttonDiv.appendChild(brightnessWrapper)

        // Toggle Stats
        const statsButton = document.createElement("button")
        statsButton.innerText = "Toggle Stats"
        statsButton.addEventListener("click", () => {
            this.app.toggleStats()
        })
        this.buttonDiv.appendChild(statsButton)

        const debugGamepadsButton = document.createElement("button")
        debugGamepadsButton.innerText = "Debug Gamepads"
        debugGamepadsButton.addEventListener("click", async () => {
            const gamepads = navigator.getGamepads()
            const lines: string[] = []

            lines.push(`Build: ${this.buildTag}`)
            lines.push(`Detected gamepad slots: ${gamepads.length}`)

            for (let i = 0; i < gamepads.length; i++) {
                const gp = gamepads[i]
                if (!gp) {
                    lines.push(`[${i}] empty`)
                    continue
                }

                lines.push(`[${i}] index=${gp.index} connected=${gp.connected} mapping=${gp.mapping}`)
                lines.push(`    id=${gp.id}`)
                lines.push(`    buttons=${gp.buttons.length} axes=${gp.axes.length} ts=${gp.timestamp}`)
            }

            // Add debug logs from StreamInput
            const streamInput = this.app.getStreamInput()
            if (streamInput) {
                lines.push("")
                lines.push("=== Input Debug Logs ===")
                const debugLogs = streamInput.getDebugLogs()
                debugLogs.forEach(log => lines.push(log))
            }

            await showMessage(lines.join("\n"))
        })
        if (!this.isTouchRemote) this.buttonDiv.appendChild(debugGamepadsButton)

        const teslaSwapButton = document.createElement("button")
        const updateTeslaSwapLabel = () => {
            const state = getTeslaVirtualSwapOverride()
            const stateLabel = state === null ? "Auto" : (state ? "On" : "Off")
            teslaSwapButton.innerText = `Tesla ABXY: ${stateLabel}`
        }
        updateTeslaSwapLabel()
        teslaSwapButton.addEventListener("click", async () => {
            const current = getTeslaVirtualSwapOverride()
            const next = current === null ? true : (current === true ? false : null)
            setTeslaVirtualSwapOverride(next)
            updateTeslaSwapLabel()

            const explain = next === null
                ? "Auto mode (ID-based detection)"
                : (next ? "Forced ON: swap Tesla virtual ABXY" : "Forced OFF: no Tesla virtual ABXY swap")
            await showMessage(`Tesla ABXY override changed to ${teslaSwapButton.innerText}.\n${explain}`)
        })
        if (!this.isTouchRemote) this.buttonDiv.appendChild(teslaSwapButton)

        const buildInfo = document.createElement("div")
        buildInfo.classList.add("sidebar-build-tag")
        buildInfo.innerText = `Build: ${this.buildTag}`
        this.div.appendChild(buildInfo)

        // Input-only device indicator (e.g. a phone attached via /input.html)
        this.inputClientsIndicator.classList.add("sidebar-build-tag")
        this.inputClientsIndicator.style.display = "none"
        this.div.appendChild(this.inputClientsIndicator)


        // YouTube uses its direct local controls, so input mode and controller
        // remapping choices would only add clutter to its touch drawer.
        if (!this.isTouchRemote) {
            this.mouseMode = new SelectComponent("mouseMode", [
                { value: "relative", name: "Relative" },
                { value: "follow", name: "Follow" },
                { value: "pointAndDrag", name: "Point and Drag" }
            ], {
                displayName: "Mouse Mode",
                preSelectedOption: this.app.getInputConfig().mouseMode
            })
            this.mouseMode.addChangeListener(this.onMouseModeChange.bind(this))
            this.mouseMode.mount(this.div)

            this.touchMode = new SelectComponent("touchMode", [
                { value: "touch", name: "Touch" },
                { value: "mouseRelative", name: "Relative" },
                { value: "pointAndDrag", name: "Point and Drag" }
            ], {
                displayName: "Touch Mode",
                preSelectedOption: this.app.getInputConfig().touchMode
            })
            this.touchMode.addChangeListener(this.onTouchModeChange.bind(this))
            this.touchMode.mount(this.div)
        }

        // Controller help is intentionally the final sidebar element, below
        // advanced settings, status, and build information.
        if (this.isYoutubeRemote && this.youtubeControllerHelp) {
            this.div.appendChild(this.youtubeControllerHelp)
        }
    }

    private buildSegmentedSetting(
        label: string,
        selectedValue: string,
        options: Array<{ value: string, label: string, title?: string }>,
        onSelect: (value: string) => void | Promise<void>,
    ): HTMLElement {
        const group = document.createElement("section")
        group.classList.add("stream-setting-group")

        const heading = document.createElement("div")
        heading.classList.add("stream-setting-heading")
        heading.innerText = label

        const segments = document.createElement("div")
        segments.classList.add("stream-segments")
        let currentValue = selectedValue

        const buttons = options.map((option) => {
            const button = document.createElement("button")
            button.type = "button"
            button.innerText = option.label
            button.dataset.value = option.value
            button.title = option.title ?? option.label

            const updateSelected = () => {
                const selected = option.value === currentValue
                button.classList.toggle("is-selected", selected)
                button.setAttribute("aria-pressed", selected ? "true" : "false")
            }
            updateSelected()

            button.addEventListener("click", async () => {
                if (option.value === currentValue) return
                buttons.forEach(candidate => candidate.disabled = true)
                segments.classList.add("is-busy")
                try {
                    await onSelect(option.value)
                    currentValue = option.value
                    buttons.forEach(candidate => {
                        const selected = candidate.dataset.value === currentValue
                        candidate.classList.toggle("is-selected", selected)
                        candidate.setAttribute("aria-pressed", selected ? "true" : "false")
                    })
                } finally {
                    buttons.forEach(candidate => candidate.disabled = false)
                    segments.classList.remove("is-busy")
                }
            })
            return button
        })

        segments.append(...buttons)
        group.append(heading, segments)
        return group
    }

    private buildUb1818Controls(): HTMLElement {
        const root = document.createElement("section")
        root.classList.add("youtube-touch-controller", "ub1818-touch-controller")

        const header = document.createElement("div")
        header.classList.add("youtube-touch-header")
        const mark = document.createElement("span")
        mark.classList.add("youtube-touch-logo", "ub1818-touch-logo")
        mark.innerText = "UB"
        const title = document.createElement("div")
        title.innerHTML = "<strong>UB1818</strong><small>Tesla Touch</small>"
        const headerExit = document.createElement("button")
        headerExit.type = "button"
        headerExit.classList.add("youtube-header-exit")
        headerExit.innerText = "×"
        headerExit.title = "Exit UB1818"
        headerExit.setAttribute("aria-label", "Exit UB1818 and return to app launcher")
        headerExit.addEventListener("click", async () => {
            if (headerExit.disabled) return
            headerExit.disabled = true
            headerExit.innerText = "…"
            try {
                await this.app.controlUb1818("quit")
            } catch (error) {
                // Still cancel the Sunshine session if Chrome has already gone.
                console.warn("Could not close UB1818 browser cleanly", error)
            }
            await this.app.exitRemoteApp()
        })
        header.append(mark, title, headerExit)
        root.appendChild(header)

        const status = document.createElement("div")
        status.classList.add("youtube-touch-status")
        status.innerText = "UB1818 controls ready"
        root.appendChild(status)

        const runControl = async (action: Ub1818ControlAction, button: HTMLButtonElement) => {
            button.disabled = true
            status.innerText = `${button.innerText}…`
            try {
                const response = await this.app.controlUb1818(action)
                status.innerText = response.ok ? "Done" : (response.message || "Command failed")
            } catch (error) {
                console.warn("UB1818 direct control failed", error)
                status.innerText = "UB1818 control is reconnecting"
            } finally {
                window.setTimeout(() => { button.disabled = false }, 160)
            }
        }
        const controlButton = (label: string, action: Ub1818ControlAction, wide = false) => {
            const button = document.createElement("button")
            button.type = "button"
            button.innerText = label
            button.classList.add("ub1818-control-button")
            if (wide) button.classList.add("ub1818-control-wide")
            button.addEventListener("click", () => void runControl(action, button))
            return button
        }

        const primaryControls = document.createElement("div")
        primaryControls.classList.add("ub1818-control-grid")
        primaryControls.append(
            controlButton("Back", "back"),
            controlButton("Home", "home"),
            controlButton("Browse / Filter", "browse", true),
            controlButton("Login / Account", "login", true),
            controlButton("Top", "top", true),
        )
        this.keyboardButton.classList.add("ub1818-control-button", "ub1818-control-wide", "ub1818-keyboard-button")
        this.keyboardButton.title = "Open the Tesla keyboard for the selected field"
        this.keyboardButton.setAttribute("aria-label", "Open keyboard")
        primaryControls.appendChild(this.keyboardButton)
        root.appendChild(primaryControls)

        // Keep restricted content out of the everyday control grid so it
        // cannot be launched by an accidental touch. It takes two deliberate
        // actions: expand this panel, then press the Midnight button.
        const restrictedPanel = document.createElement("details")
        restrictedPanel.classList.add("youtube-link-panel", "ub1818-restricted-panel")
        const restrictedSummary = document.createElement("summary")
        restrictedSummary.innerText = "Restricted content"
        const restrictedList = document.createElement("div")
        restrictedList.classList.add("youtube-link-list")
        restrictedList.appendChild(controlButton("午夜版", "midnight", true))
        restrictedPanel.append(restrictedSummary, restrictedList)
        root.appendChild(restrictedPanel)

        const dpad = document.createElement("div")
        dpad.classList.add("ub1818-dpad")
        const up = controlButton("↑", "focus_up")
        up.title = "Select the movie above and show its preview"
        up.classList.add("ub1818-dpad-up")
        const left = controlButton("←", "focus_left")
        left.title = "Select the movie on the left and show its preview"
        left.classList.add("ub1818-dpad-left")
        const ok = controlButton("Open", "select")
        ok.title = "Open the selected movie"
        ok.classList.add("ub1818-dpad-ok")
        const right = controlButton("→", "focus_right")
        right.title = "Select the movie on the right and show its preview"
        right.classList.add("ub1818-dpad-right")
        const down = controlButton("↓", "focus_down")
        down.title = "Select the movie below and show its preview"
        down.classList.add("ub1818-dpad-down")
        dpad.append(up, left, ok, right, down)
        root.appendChild(dpad)

        const pageControls = document.createElement("div")
        pageControls.classList.add("ub1818-page-controls")
        pageControls.append(
            controlButton("Pg Up", "scroll_up"),
            controlButton("Next Page", "scroll_down"),
        )
        root.appendChild(pageControls)

        const playbackControls = document.createElement("div")
        playbackControls.classList.add("ub1818-control-grid")
        playbackControls.append(
            controlButton("Play / Pause", "play_pause"),
            controlButton("Fullscreen", "fullscreen"),
        )
        root.appendChild(playbackControls)
        return root
    }

    private buildYoutubeControls(): HTMLElement {
        const root = document.createElement("section")
        root.classList.add("youtube-touch-controller")

        const header = document.createElement("div")
        header.classList.add("youtube-touch-header")
        const mark = document.createElement("span")
        mark.classList.add("youtube-touch-logo")
        mark.innerText = "▶"
        const title = document.createElement("div")
        title.innerHTML = "<strong>YouTube</strong><small>Tesla Touch</small>"
        const headerExit = document.createElement("button")
        headerExit.type = "button"
        headerExit.classList.add("youtube-header-exit")
        headerExit.innerText = "×"
        headerExit.title = "Exit YouTube"
        headerExit.setAttribute("aria-label", "Exit YouTube and show Desktop")
        headerExit.addEventListener("click", () => void this.runYoutubeAction("exit", undefined, headerExit))
        header.append(mark, title, headerExit)
        root.appendChild(header)

        this.youtubeStatus.classList.add("youtube-touch-status")
        this.youtubeStatus.innerText = "Direct controls ready"
        root.appendChild(this.youtubeStatus)

        const brightnessControl = document.createElement("div")
        brightnessControl.classList.add("youtube-opacity-control")
        const brightnessHeader = document.createElement("label")
        brightnessHeader.innerHTML = "<span>Brightness</span>"
        const brightnessValue = document.createElement("output")
        const brightnessSlider = document.createElement("input")
        const initialScreenBrightness = this.app.getScreenBrightness()
        brightnessSlider.type = "range"
        brightnessSlider.min = "-50"
        brightnessSlider.max = "50"
        brightnessSlider.step = "1"
        brightnessSlider.value = String(initialScreenBrightness)
        brightnessValue.value = formatBrightnessOffset(initialScreenBrightness)
        brightnessHeader.appendChild(brightnessValue)
        brightnessSlider.setAttribute("aria-label", "Screen brightness offset")
        brightnessSlider.addEventListener("input", () => {
            const value = Number.parseInt(brightnessSlider.value, 10)
            brightnessValue.value = formatBrightnessOffset(value)
            this.app.setScreenBrightness(value)
        })
        brightnessControl.append(brightnessHeader, brightnessSlider)
        this.app.setScreenBrightness(initialScreenBrightness)
        root.appendChild(brightnessControl)

        const searchForm = document.createElement("form")
        searchForm.classList.add("youtube-touch-search", "youtube-touch-card")
        const searchInput = document.createElement("input")
        searchInput.type = "search"
        searchInput.placeholder = "Search YouTube"
        searchInput.maxLength = 200
        searchInput.autocomplete = "off"
        searchInput.autocapitalize = "off"
        searchInput.spellcheck = false
        const searchButton = document.createElement("button")
        searchButton.type = "submit"
        searchButton.innerText = "Search"
        searchForm.append(searchInput, searchButton)
        searchForm.addEventListener("submit", (event) => {
            event.preventDefault()
            const query = searchInput.value.trim()
            if (query) void this.runYoutubeAction("search", query, searchButton)
        })
        root.appendChild(searchForm)

        const linksPanel = document.createElement("details")
        linksPanel.classList.add("youtube-link-panel")
        const linksSummary = document.createElement("summary")
        linksSummary.innerText = "YouTube links"
        const linksList = document.createElement("div")
        linksList.classList.add("youtube-link-list")
        const youtubeLinkButton = (label: string, destination: "history" | "playlists" | "subscriptions") => {
            const button = document.createElement("button")
            button.type = "button"
            button.innerText = label
            button.title = `Open ${label}`
            button.addEventListener("click", () => void this.runYoutubeAction("home", destination, button))
            return button
        }
        linksList.append(
            youtubeLinkButton("Watch history", "history"),
            youtubeLinkButton("Playlists", "playlists"),
            youtubeLinkButton("Subscribed", "subscriptions"),
        )
        linksPanel.append(linksSummary, linksList)
        root.appendChild(linksPanel)

        const sectionLabel = (text: string) => {
            const label = document.createElement("div")
            label.classList.add("youtube-touch-section-label")
            label.innerText = text
            return label
        }
        const actionButton = (
            label: string,
            action: YoutubeControlAction,
            className?: string,
            title?: string,
        ) => {
            const button = document.createElement("button")
            button.type = "button"
            button.innerText = label
            button.dataset.youtubeAction = action
            if (className) button.classList.add(...className.split(" "))
            if (title) {
                button.title = title
                button.setAttribute("aria-label", title)
            }
            button.addEventListener("click", () => void this.runYoutubeAction(action, undefined, button))
            return button
        }

        const homeRow = document.createElement("div")
        homeRow.classList.add("youtube-touch-grid", "youtube-touch-home-row")
        homeRow.append(
            actionButton("Home", "home", "youtube-home-key", "YouTube Home"),
            actionButton("Back", "back", "youtube-home-key", "YouTube Back"),
        )
        linksPanel.insertAdjacentElement("afterend", homeRow)

        const browseCard = document.createElement("section")
        browseCard.classList.add("youtube-touch-card")
        browseCard.appendChild(sectionLabel("Browse"))
        const dpad = document.createElement("div")
        dpad.classList.add("youtube-touch-dpad")
        dpad.append(
            actionButton("↑", "focus_up", "youtube-dpad-key youtube-dpad-vertical", "Select video above"),
            actionButton("←", "focus_left", "youtube-dpad-key", "Select video to the left"),
            actionButton("OK", "select", "youtube-dpad-ok", "Open selected video"),
            actionButton("→", "focus_right", "youtube-dpad-key", "Select video to the right"),
            actionButton("↓", "focus_down", "youtube-dpad-key youtube-dpad-vertical", "Select video below"),
        )
        browseCard.appendChild(dpad)

        const pageGrid = document.createElement("div")
        pageGrid.classList.add("youtube-touch-grid", "youtube-touch-page-grid")
        pageGrid.append(
            actionButton("Pg ↓", "scroll_down", "youtube-compact-key", "Page down"),
            actionButton("Pg ↑", "scroll_up", "youtube-compact-key", "Page up"),
        )
        browseCard.appendChild(pageGrid)
        root.appendChild(browseCard)

        const playbackCard = document.createElement("section")
        playbackCard.classList.add("youtube-touch-card")
        playbackCard.appendChild(sectionLabel("Playback"))

        // Previous and Next are frequent, high-consequence navigation actions.
        // Give each half of its own row instead of squeezing both beside seek.
        const trackNavigation = document.createElement("div")
        trackNavigation.classList.add("youtube-touch-grid", "youtube-touch-track-row")
        const previous = actionButton("Prev", "previous", "youtube-icon-key", "Previous video")
        const next = actionButton("Next", "next", "youtube-icon-key", "Next video")
        trackNavigation.append(previous, next)
        playbackCard.appendChild(trackNavigation)

        const playback = document.createElement("div")
        playback.classList.add("youtube-touch-grid", "youtube-touch-transport")
        const seekBack = actionButton("-10", "seek_back", "youtube-icon-key", "Back 10 seconds")
        this.youtubePlayButton = actionButton("Play", "play_pause", "youtube-touch-primary youtube-icon-key", "Play or pause")
        const seekForward = actionButton("+10", "seek_forward", "youtube-icon-key", "Forward 10 seconds")
        playback.append(
            seekBack, this.youtubePlayButton, seekForward,
        )
        playbackCard.appendChild(playback)

        const sound = document.createElement("div")
        sound.classList.add("youtube-touch-grid", "youtube-touch-sound-row")
        const volumeDown = actionButton("Vol -", "volume_down", "youtube-compact-key", "Volume down")
        this.youtubeMuteButton = actionButton("Mute", "mute", "youtube-compact-key")
        const captions = actionButton("CC", "captions", "youtube-compact-key", "Toggle captions")
        const volumeUp = actionButton("Vol +", "volume_up", "youtube-compact-key", "Volume up")
        sound.append(volumeDown, this.youtubeMuteButton, captions, volumeUp)
        playbackCard.appendChild(sound)

        const fullscreen = actionButton(
            "Player fullscreen",
            "fullscreen",
            "youtube-touch-wide youtube-player-fullscreen",
            "Toggle YouTube player fullscreen",
        )
        playbackCard.appendChild(fullscreen)
        root.appendChild(playbackCard)

        // Keep the controller reference at the very bottom. Both the PS4 buttons
        // and their actions are drawn as CSS/SVG icons so Tesla cannot substitute
        // broken controller glyphs or fill the compact panel with long labels.
        const controllerHelp = document.createElement("div")
        controllerHelp.classList.add("youtube-controller-map")
        controllerHelp.innerHTML = `<strong><span class="ps4-controller-mark" aria-hidden="true"></span><span class="sr-only">PS4 controls</span></strong>
            <div class="ps4-map-grid">
                <span title="Cross: open" aria-label="Cross: open"><i class="ps4-icon ps4-cross" aria-hidden="true"></i><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12h13m-5-5 5 5-5 5"/></svg></span>
                <span title="Circle: back" aria-label="Circle: back"><i class="ps4-icon ps4-circle" aria-hidden="true"></i><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M19 12H6m5-5-5 5 5 5"/></svg></span>
                <span title="Square: play or pause" aria-label="Square: play or pause"><i class="ps4-icon ps4-square" aria-hidden="true"></i><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 5 7 4.5L5 14V5Z"/><path d="M15 6v12m4-12v12"/></svg></span>
                <span title="Triangle: fullscreen" aria-label="Triangle: fullscreen"><i class="ps4-icon ps4-triangle" aria-hidden="true"></i><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/></svg></span>
            </div>
            <div class="ps4-map-shoulders">
                <span title="L1: rewind 10 seconds" aria-label="L1: rewind 10 seconds"><i>L1</i><b>−10</b></span><span title="R1: forward 10 seconds" aria-label="R1: forward 10 seconds"><i>R1</i><b>+10</b></span>
                <span title="L2: volume down" aria-label="L2: volume down"><i>L2</i><svg aria-hidden="true" viewBox="0 0 28 24"><path d="M4 10h4l5-4v12l-5-4H4z"/><path d="M18 12h7"/></svg></span><span title="R2: volume up" aria-label="R2: volume up"><i>R2</i><svg aria-hidden="true" viewBox="0 0 28 24"><path d="M4 10h4l5-4v12l-5-4H4z"/><path d="M18 12h7m-3.5-3.5v7"/></svg></span>
                <span title="Share: captions" aria-label="Share: captions"><i>SH</i><b class="ps4-cc-icon">CC</b></span><span title="Options: YouTube home" aria-label="Options: YouTube home"><i>OPT</i><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 11 8-7 8 7v9h-6v-6h-4v6H4z"/></svg></span>
                <span title="L3: mute" aria-label="L3: mute"><i>L3</i><svg aria-hidden="true" viewBox="0 0 28 24"><path d="M3 10h4l5-4v12l-5-4H3z"/><path d="m18 8 7 8m0-8-7 8"/></svg></span><span class="ps4-r3-menu" title="R3: show or hide Sunshine menu" aria-label="R3: show or hide Sunshine menu"><i>R3</i><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg></span>
            </div>`
        this.youtubeControllerHelp = controllerHelp

        return root
    }

    private formatYoutubeTime(seconds?: number | null): string {
        if (seconds == null || !Number.isFinite(seconds)) return ""
        const value = Math.max(0, Math.round(seconds))
        const minutes = Math.floor(value / 60)
        const rawRemainder = String(value % 60)
        const remainder = rawRemainder.length < 2 ? `0${rawRemainder}` : rawRemainder
        return `${minutes}:${remainder}`
    }

    private async runYoutubeAction(
        action: YoutubeControlAction,
        query?: string,
        button?: HTMLButtonElement,
    ) {
        this.youtubeStatus.innerText = action === "search"
            ? `Searching for “${query}”…`
            : action === "home" && query
                ? `Opening ${query === "history"
                    ? "Watch history"
                    : query === "playlists"
                        ? "Playlists"
                        : "Subscribed"}…`
                : "Command sent…"
        button?.classList.add("youtube-command-active")
        try {
            const response = await this.app.controlYoutube(action, query)
            if (!response.ok) {
                this.youtubeStatus.innerText = response.message || "Open a video first"
                return
            }
            const status = response.status
            if (status) {
                if (this.youtubePlayButton && status.paused != null) {
                    this.youtubePlayButton.innerText = status.paused ? "Play" : "Pause"
                }
                if (this.youtubeMuteButton && status.muted != null) {
                    this.youtubeMuteButton.innerText = status.muted ? "Unmute" : "Mute"
                }
                const time = status.currentTime != null
                    ? `${this.formatYoutubeTime(status.currentTime)}${status.duration ? ` / ${this.formatYoutubeTime(status.duration)}` : ""}`
                    : ""
                const volume = status.volume != null ? ` · Vol ${status.volume}%` : ""
                this.youtubeStatus.innerText = `${status.title || "YouTube"}${time ? ` · ${time}` : ""}${volume}`
            } else {
                this.youtubeStatus.innerText = action === "exit" ? "YouTube closed — Desktop is visible" : "Done"
            }
            if (action === "exit") setSidebarExtended(false)
        } catch (error) {
            console.warn("YouTube direct control failed", error)
            this.youtubeStatus.innerText = "YouTube is still starting — try again"
        } finally {
            window.setTimeout(() => button?.classList.remove("youtube-command-active"), 120)
        }
    }

    onCapabilitiesChange(capabilities: StreamCapabilities) {
        this.touchMode?.setOptionEnabled("touch", capabilities.touch)
    }

    setControllerStatus(gamepad: Gamepad | null) {
        // Preserve the compact YouTube status line while still exposing
        // controller connectivity to diagnostics and assistive UI.
        if (!this.isYoutubeRemote) return
        if (gamepad) {
            this.youtubeStatus.dataset.controllerConnected = "true"
            this.youtubeStatus.title = `Controller connected: ${gamepad.id}`
        } else {
            delete this.youtubeStatus.dataset.controllerConnected
            this.youtubeStatus.removeAttribute("title")
        }
    }

    onInputClientsChanged(count: number) {
        if (count <= 0) {
            this.inputClientsIndicator.style.display = "none"
            return
        }

        this.inputClientsIndicator.style.display = ""
        this.inputClientsIndicator.innerText = count == 1
            ? "1 input-only device connected"
            : `${count} input-only devices connected`
    }

    getScreenKeyboard(): ScreenKeyboard {
        return this.screenKeyboard
    }

    // -- Keyboard
    private onText(event: TextEvent) {
        this.app.getStream()?.getInput().sendText(event.detail.text)
    }
    private onKeyDown(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyDown(event)
    }
    private onKeyUp(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyUp(event)
    }
    private onKeyboardModeChange(event: KeyboardModeEvent) {
        if (event.detail.enabled) {
            this.floatingKeyboardButton.style.display = "flex"
        } else {
            this.floatingKeyboardButton.style.display = "none"
            this.app.recoverAfterScreenKeyboard()
            if (this.isUb1818Remote) {
                // Tesla keeps the drawer's scroll offset from the short visual
                // viewport used by its on-screen keyboard. Once the viewport
                // grows again that stale offset can place every child outside
                // the visible panel, making the Sunshine drawer look blank.
                // UB1818 always opens the keyboard from this drawer, so restore
                // it to a deterministic, usable state after keyboard dismissal.
                const restoreDrawer = () => {
                    const sidebarRoot = getSidebarRoot()
                    const sidebarContent = document.getElementById("sidebar-parent")
                    if (sidebarRoot) sidebarRoot.style.visibility = "visible"
                    if (sidebarContent) {
                        sidebarContent.scrollTop = 0
                        sidebarContent.scrollLeft = 0
                    }
                    setSidebarExtended(true)
                    window.dispatchEvent(new Event("resize"))
                }
                window.requestAnimationFrame(restoreDrawer)
                window.setTimeout(restoreDrawer, 250)
                window.setTimeout(() => {
                    restoreDrawer()
                    this.app.getStream()?.sendClientLogMessage(
                        `[Tesla Keyboard] UB1818 drawer restored; children=${document.getElementById("sidebar-parent")?.childElementCount ?? 0}`
                    )
                }, 650)
            }
        }
    }

    // -- Mouse Mode
    private onMouseModeChange() {
        if (!this.mouseMode) return
        const config = this.app.getInputConfig()
        config.mouseMode = this.mouseMode.getValue() as any
        this.app.setInputConfig(config)
    }

    // -- Touch Mode
    private onTouchModeChange() {
        if (!this.touchMode) return
        const config = this.app.getInputConfig()
        config.touchMode = this.touchMode.getValue() as any
        this.app.setInputConfig(config)
    }

    extended(): void {

    }
    unextend(): void {

    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
        const appRoot = document.getElementById("root")
        ;(appRoot ?? document.body).appendChild(this.floatingKeyboardButton)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
        if (this.floatingKeyboardButton.parentElement) {
            this.floatingKeyboardButton.parentElement.removeChild(this.floatingKeyboardButton)
        }
    }
}

class SendKeycodeModal extends FormModal<number> {

    private dropdownSearch: SelectComponent

    constructor() {
        super()

        const keyList = []
        for (const keyName of Object.keys(StreamKeys)) {
            const keyValue = StreamKeys[keyName]

            const PREFIX = "VK_"

            let name = keyName
            if (name.startsWith(PREFIX)) {
                name = name.slice(PREFIX.length)
            }

            keyList.push({
                value: keyValue.toString(),
                name
            })
        }

        this.dropdownSearch = new SelectComponent("winKeycode", keyList, {
            hasSearch: true,
            displayName: "Select Keycode"
        })
    }

    mountForm(form: HTMLFormElement): void {
        this.dropdownSearch.mount(form)
    }


    reset(): void {
        this.dropdownSearch.reset()
    }

    submit(): number | null {
        const keyString = this.dropdownSearch.getValue()
        if (keyString == null) {
            return null
        }

        return parseInt(keyString)
    }
}

// Stop propagation so the stream doesn't get it
function stopPropagationOn(element: HTMLElement) {
    element.addEventListener("keydown", onStopPropagation)
    element.addEventListener("keyup", onStopPropagation)
    element.addEventListener("keypress", onStopPropagation)
    element.addEventListener("click", onStopPropagation)
    element.addEventListener("mousedown", onStopPropagation)
    element.addEventListener("mouseup", onStopPropagation)
    element.addEventListener("mousemove", onStopPropagation)
    element.addEventListener("wheel", onStopPropagation)
    element.addEventListener("contextmenu", onStopPropagation)
    element.addEventListener("touchstart", onStopPropagation)
    element.addEventListener("touchmove", onStopPropagation)
    element.addEventListener("touchend", onStopPropagation)
    element.addEventListener("touchcancel", onStopPropagation)
}

// Tesla's browser can interpret a rightward swipe inside the open drawer as
// browser Back, unloading the stream and leaving an empty sidebar shell. Keep
// vertical menu scrolling and native range-input dragging, but consume other
// clearly horizontal drawer gestures before the browser handles them.
function preventHorizontalNavigationOn(element: HTMLElement) {
    let startX = 0
    let startY = 0
    let tracking = false

    element.addEventListener("touchstart", (event) => {
        const touch = event.touches.item(0)
        if (!touch || event.touches.length !== 1) {
            tracking = false
            return
        }
        const target = event.target as Element | null
        if (target?.closest('input[type="range"]')) {
            tracking = false
            return
        }
        startX = touch.clientX
        startY = touch.clientY
        tracking = true
    }, { passive: true })

    element.addEventListener("touchmove", (event) => {
        if (!tracking) return
        const touch = event.touches.item(0)
        if (!touch) return
        const deltaX = touch.clientX - startX
        const deltaY = touch.clientY - startY
        if (Math.abs(deltaX) >= 10 && Math.abs(deltaX) > Math.abs(deltaY)) {
            event.preventDefault()
        }
    }, { passive: false })

    const stopTracking = () => { tracking = false }
    element.addEventListener("touchend", stopTracking, { passive: true })
    element.addEventListener("touchcancel", stopTracking, { passive: true })
}
function onStopPropagation(event: Event) {
    event.stopPropagation()
}
