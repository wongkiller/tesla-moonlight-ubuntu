(() => {
  "use strict";

  const RAIL_ID = "cockpit-youtube-rail";
  const INSTALLATION_KEY = "__cockpitYouTubeRemoteInstallation";
  const INSTALLATION_VERSION = 15;
  const LAYOUT_STORAGE_KEY = "cockpitYouTubeLayout";
  const existingInstallation = globalThis[INSTALLATION_KEY];

  if (existingInstallation?.version === INSTALLATION_VERSION && existingInstallation.installRail) {
    existingInstallation.installRail();
    return;
  }
  existingInstallation?.observer?.disconnect?.();
  document.getElementById(RAIL_ID)?.remove();

  const buttons = [
    ["home", "⌂", "YouTube home"],
    ["back", "←", "Go back"],
    ["search", "⌕", "Search"],
    ["top", "↑", "Scroll to top"],
    ["fullscreen", "⛶", "Toggle YouTube page fullscreen"],
    ["collapse", "›", "Collapse controls"]
  ];

  function focusSearch() {
    const input = document.querySelector(
      "input#search, ytd-searchbox input, input[name='search_query']"
    );
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select?.();
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      console.warn("Cockpit YouTube Remote: fullscreen request failed", error);
    }
  }

  const ZOOM_HOST_SELECTOR = [
    ".ytLockupViewModelHost",
    "ytm-shorts-lockup-view-model.shortsLockupViewModelHost",
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-rich-grid-slim-media"
  ].join(",");

  function zoomHostFor(element) {
    if (!(element instanceof Element)) return null;
    return element.closest(ZOOM_HOST_SELECTOR);
  }

  function clearZoomPosition(except) {
    document.querySelectorAll('[data-cockpit-zoom-positioned="true"]').forEach((host) => {
      if (host === except) return;
      host.removeAttribute("data-cockpit-zoom-positioned");
      host.removeAttribute("data-cockpit-zoom-related");
      host.removeAttribute("data-cockpit-zoom-kind");
      host.style.removeProperty("--cockpit-zoom-origin-x");
      host.style.removeProperty("--cockpit-zoom-origin-y");
      host.style.removeProperty("--cockpit-zoom-shift-x");
      host.style.removeProperty("--cockpit-zoom-scale");
    });
  }

  function positionZoomHost(element) {
    const host = zoomHostFor(element);
    if (!host) return null;
    clearZoomPosition(host);

    // Search results are already full-width horizontal cards, while Shorts
    // are tall and closely packed. Give each surface its own safe scale.
    const savedTransform = host.style.getPropertyValue("transform");
    const savedTransformPriority = host.style.getPropertyPriority("transform");
    const savedTransition = host.style.getPropertyValue("transition");
    const savedTransitionPriority = host.style.getPropertyPriority("transition");
    document.documentElement.classList.add("cockpit-youtube-measuring");
    host.style.setProperty("transform", "none", "important");
    host.style.setProperty("transition", "none", "important");
    const rect = host.getBoundingClientRect();
    if (savedTransform) host.style.setProperty("transform", savedTransform, savedTransformPriority);
    else host.style.removeProperty("transform");
    if (savedTransition) host.style.setProperty("transition", savedTransition, savedTransitionPriority);
    else host.style.removeProperty("transition");
    document.documentElement.classList.remove("cockpit-youtube-measuring");
    const href = element.closest('a[href]')?.getAttribute("href") || "";
    const isRelated = Boolean(host.closest("#related, ytd-watch-next-secondary-results-renderer"));
    const isSearch = location.pathname === "/results" && !isRelated;
    const isShorts = href.includes("/shorts/") || host.matches("ytm-shorts-lockup-view-model, ytd-rich-grid-slim-media");
    const isGame = href.includes("/playables/");
    const kind = isRelated ? "related" : isSearch ? "search" : isShorts ? "shorts" : isGame ? "game" : "grid";
    // Every card on /results belongs to the compact search surface, including
    // cards inside a Shorts shelf. Applying the Home-page Shorts scale (1.28)
    // here makes a selected Short cover its neighbours and can widen the page.
    let scale = isSearch ? 1.04 : isShorts ? 1.28 : isGame ? 1.32 : 1.5;
    const sideRoom = Math.max(18, innerWidth * 0.015);
    const verticalRoom = Math.max(16, innerHeight * 0.02);
    const extraX = rect.width * (scale - 1) / 2;
    const extraY = rect.height * (scale - 1) / 2;
    const edgeNudge = 28;

    let originX = "center";
    let originY = "center";
    let shiftX = 0;
    if (isSearch) {
      // A search result already spans almost the whole content column. Grow
      // gently to the right and cap the scale to the actual free width, so
      // its title/description never disappear behind either page edge.
      const safeLeft = Math.max(sideRoom, 76);
      const safeRight = innerWidth - sideRoom;
      const availableWidth = Math.max(1, safeRight - safeLeft);
      scale = Math.max(1, Math.min(1.04, availableWidth / rect.width));
      originX = "left";
      const desiredLeft = Math.max(rect.left, safeLeft);
      const fittedLeft = Math.min(desiredLeft, safeRight - rect.width * scale);
      shiftX = fittedLeft - rect.left;
    } else if (isRelated) {
      // Grow the watch-page recommendation into the open video/comments side,
      // keeping its right edge fixed and visible.
      originX = "right";
      shiftX = -Math.min(32, Math.max(0, rect.left - sideRoom));
      host.dataset.cockpitZoomRelated = "true";
    } else if (rect.right + extraX > innerWidth - sideRoom) {
      originX = "right";
      shiftX = -Math.min(edgeNudge, Math.max(0, rect.left - sideRoom));
    } else if (rect.left - extraX < sideRoom || rect.left < innerWidth * 0.34) {
      originX = "left";
      shiftX = Math.min(edgeNudge, Math.max(0, innerWidth - rect.right - sideRoom));
    }
    if (rect.top - extraY < verticalRoom) originY = "top";
    else if (rect.bottom + extraY > innerHeight - verticalRoom) originY = "bottom";

    host.style.setProperty("--cockpit-zoom-origin-x", originX);
    host.style.setProperty("--cockpit-zoom-origin-y", originY);
    host.style.setProperty("--cockpit-zoom-shift-x", `${shiftX}px`);
    host.style.setProperty("--cockpit-zoom-scale", String(scale));
    host.dataset.cockpitZoomPositioned = "true";
    host.dataset.cockpitZoomKind = kind;
    return host;
  }

  function positionHoveredCard(event) {
    const link = event.target instanceof Element
      ? event.target.closest('a[href*="/watch"], a[href*="/shorts/"], a[href*="/playables/"]')
      : null;
    if (link) positionZoomHost(link);
  }

  function runAction(action, rail) {
    switch (action) {
      case "home":
        location.assign("https://www.youtube.com/");
        break;
      case "back":
        history.back();
        break;
      case "search":
        focusSearch();
        break;
      case "top":
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "fullscreen":
        void toggleFullscreen();
        break;
      case "collapse":
        rail.classList.toggle("cockpit-collapsed");
        break;
      default:
        break;
    }
  }

  function installRail() {
    // Page.addScriptToEvaluateOnNewDocument runs before HTML/BODY exist on a
    // full Home navigation. Wait for the observer's first DOM mutation rather
    // than throwing and permanently skipping installation for that document.
    if (!document.documentElement || !document.body) return;
    document.body.classList.add("cockpit-youtube-remote");
    applyLayout("focus");
    if (document.getElementById(RAIL_ID)) return;

    const rail = document.createElement("nav");
    rail.id = RAIL_ID;
    rail.setAttribute("aria-label", "Tesla YouTube controls");

    for (const [action, label, title] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = label;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.addEventListener("click", () => runAction(action, rail));
      rail.append(button);
    }

    document.body.append(rail);
  }

  function applyLayout(requestedLayout) {
    // Keep YouTube's native responsive layout and add only the persistent
    // in-place poster zoom. Put the durable marker on HTML because YouTube's
    // SPA navigation can rewrite BODY classes when Home is opened.
    const layout = "focus";
    localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
    document.documentElement.dataset.cockpitYoutubeLayout = layout;
    document.documentElement.classList.add("cockpit-youtube-focus-zoom");
    document.body?.classList.remove("cockpit-youtube-layout-tv");
    document.body?.classList.remove("cockpit-youtube-layout-touch");
    document.body?.classList.add("cockpit-youtube-focus-zoom");

    const grid = document.querySelector("ytd-rich-grid-renderer #contents.ytd-rich-grid-renderer");
    if (grid) {
      for (const property of ["display", "grid-template-columns", "column-gap", "row-gap", "align-items"]) {
        grid.style.removeProperty(property);
      }
    }

    document.querySelectorAll("ytd-rich-item-renderer").forEach((item) => {
      for (const property of ["width", "max-width", "margin"]) item.style.removeProperty(property);
    });

    document.querySelectorAll("ytd-rich-section-renderer, ytd-continuation-item-renderer").forEach((section) => {
      section.style.removeProperty("grid-column");
    });
    return layout;
  }

  const installation = {
    version: INSTALLATION_VERSION,
    installCount: 1,
    installRail,
    applyLayout,
    positionZoomHost,
    observer: new MutationObserver(installRail)
  };
  globalThis[INSTALLATION_KEY] = installation;

  installRail();
  document.addEventListener("pointerover", positionHoveredCard, { passive: true });
  window.addEventListener("resize", () => {
    const selected = document.querySelector('[data-cockpit-selected="true"]');
    if (selected) positionZoomHost(selected);
  }, { passive: true });
  installation.observer.observe(document, {
    childList: true,
    subtree: true
  });
})();
