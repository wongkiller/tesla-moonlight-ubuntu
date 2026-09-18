import { Component } from "../index.js"
import { showErrorPopup } from "../error.js"

export interface Sidebar extends Component {
    extended(): void
    unextend(): void
}

let sidebarExtended = false
const sidebarRoot = document.getElementById("sidebar-root")
const sidebarParent = document.getElementById("sidebar-parent")
const sidebarButton = document.getElementById("sidebar-button")

sidebarButton?.addEventListener("click", toggleSidebar)

let sidebarComponent: Sidebar | null = null

let youtubeDocked = false
function syncYoutubeDockState() {
    const nextDocked = sidebarExtended && sidebarComponent != null &&
        sidebarRoot?.classList.contains("sidebar-youtube-active") === true
    document.body.classList.toggle("youtube-sidebar-docked", nextDocked)
    if (nextDocked !== youtubeDocked) {
        youtubeDocked = nextDocked
        // Re-run the stream canvas and pointer-mapping resize path after the
        // dock changes the available viewport.
        window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")))
    }
}

export type SidebarEdge = "up" | "down" | "left" | "right"
export type SidebarStyle = {
    edge?: SidebarEdge
}

export function setSidebarStyle(style: SidebarStyle) {
    // Default values
    // YouTube uses a non-overlapping left dock. Preserve the configured edge
    // for every other streamed app.
    const edge = sidebarRoot?.classList.contains("sidebar-youtube-active")
        ? "left"
        : (style.edge ?? "left")

    // Set edge
    sidebarRoot?.classList.remove("sidebar-edge-left", "sidebar-edge-right", "sidebar-edge-up", "sidebar-edge-down")
    sidebarRoot?.classList.add(`sidebar-edge-${edge}`)
    syncYoutubeDockState()
}

export function toggleSidebar() {
    setSidebarExtended(!isSidebarExtended())
}
export function setSidebarExtended(extended: boolean) {
    if (extended == sidebarExtended) {
        return
    }

    if (extended) {
        sidebarRoot?.classList.add("sidebar-show")
    } else {
        sidebarRoot?.classList.remove("sidebar-show")
    }
    sidebarExtended = extended
    syncYoutubeDockState()
}
export function isSidebarExtended(): boolean {
    return sidebarExtended
}

export function setSidebar(sidebar: Sidebar | null) {
    if (sidebarParent == null || sidebarRoot == null) {
        showErrorPopup("failed to get sidebar")
        return
    }

    if (sidebarComponent) {
        // unmount
        sidebarComponent?.unmount(sidebarParent)
        sidebarComponent = null
        sidebarRoot.style.visibility = "hidden"
    }
    if (sidebar) {
        // mount
        sidebarComponent = sidebar
        sidebar?.mount(sidebarParent)
        sidebarRoot.style.visibility = "visible"
    }
    syncYoutubeDockState()
}

export function getSidebarRoot(): HTMLElement | null {
    return sidebarRoot
}

// initialize defaults
setSidebarStyle({
    edge: "left"
})
setSidebar(null)
