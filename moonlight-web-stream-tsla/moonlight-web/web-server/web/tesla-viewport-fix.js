// Tesla 2026.26 changed the browser from DPR 1 to roughly DPR 1.53. The
// physical panel did not change, but every CSS pixel became 1.53x larger.
// Counter that browser-only zoom while leaving normal HiDPI tablets alone.
(function () {
    "use strict"

    function rawViewport() {
        const visual = window.visualViewport
        return {
            width: Math.max(1, visual?.width || document.documentElement.clientWidth || window.innerWidth || 1),
            height: Math.max(1, visual?.height || document.documentElement.clientHeight || window.innerHeight || 1),
            offsetLeft: Math.max(0, visual?.offsetLeft || 0),
            offsetTop: Math.max(0, visual?.offsetTop || 0),
        }
    }

    function compensationScale(viewport) {
        const dpr = window.devicePixelRatio || 1
        // Browser fullscreen changes visualViewport.width from roughly 773px
        // to 1256px on the same Tesla panel. Do not use viewport width as an
        // identity check: doing so disabled compensation exactly when the
        // browser entered fullscreen and enlarged the whole app by the DPR.
        const newTeslaBrowser =
            navigator.maxTouchPoints >= 10 &&
            dpr >= 1.4 && dpr <= 1.7 &&
            window.screen.width >= 1100 && window.screen.width <= 1500
        return newTeslaBrowser ? 1 / dpr : 1
    }

    let frame = 0
    function sync() {
        const viewport = rawViewport()
        const scale = compensationScale(viewport)
        const layoutWidth = viewport.width / scale
        const layoutHeight = viewport.height / scale
        const layoutLeft = viewport.offsetLeft / scale
        const layoutTop = viewport.offsetTop / scale
        const root = document.documentElement

        root.classList.add("visible-viewport-managed")
        root.classList.toggle("tesla-browser-zoom-compensated", scale < 0.99)
        root.style.setProperty("--tesla-browser-ui-scale", String(scale))
        root.style.setProperty("--visible-viewport-width", `${layoutWidth}px`)
        root.style.setProperty("--visible-viewport-height", `${layoutHeight}px`)
        root.style.setProperty("--visible-viewport-left", `${layoutLeft}px`)
        root.style.setProperty("--visible-viewport-top", `${layoutTop}px`)

        window.__teslaViewportMetrics = {
            rawWidth: viewport.width,
            rawHeight: viewport.height,
            layoutWidth,
            layoutHeight,
            scale,
            dpr: window.devicePixelRatio || 1,
        }
        return window.__teslaViewportMetrics
    }

    function scheduleSync() {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(function () {
            frame = 0
            sync()
        })
    }

    window.__syncTeslaViewport = sync
    sync()
    window.addEventListener("resize", scheduleSync, { passive: true })
    window.addEventListener("orientationchange", scheduleSync, { passive: true })
    window.addEventListener("pageshow", scheduleSync, { passive: true })
    window.visualViewport?.addEventListener("resize", scheduleSync, { passive: true })
    window.visualViewport?.addEventListener("scroll", scheduleSync, { passive: true })
})()
