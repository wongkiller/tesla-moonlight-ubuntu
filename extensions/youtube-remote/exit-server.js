#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const tokenFile = process.argv[2];
const stopScript = process.argv[3];
if (!tokenFile || !stopScript) {
  console.error("Usage: exit-server.js TOKEN_FILE STOP_SCRIPT");
  process.exit(2);
}

const expectedToken = fs.readFileSync(tokenFile, "utf8").trim();
const debugBaseUrl = "http://127.0.0.1:9227";
const allowedActions = new Set([
  "home", "back", "search", "top", "scroll_up", "scroll_down",
  "focus_up", "focus_down", "focus_left", "focus_right", "select",
  "play_pause", "pause", "seek_back", "seek_forward", "previous", "next",
  "volume_down", "volume_up", "mute", "captions", "fullscreen", "layout", "exit"
]);

let activeClient = null;
let controlQueue = Promise.resolve();

// This persistent helper is the sole owner of page injection. Keeping its CDP
// socket open also keeps the new-document registration alive across reloads.
function buildLayoutBootstrap() {
  const extensionDir = path.join(__dirname, "chrome-extension");
  const css = fs.readFileSync(path.join(extensionDir, "youtube-remote.css"), "utf8");
  const javascript = fs.readFileSync(path.join(extensionDir, "youtube-remote.js"), "utf8");
  return `(() => {
    if (!/(^|\\.)youtube\\.com$/.test(location.hostname)) return;
    Reflect.deleteProperty(globalThis, "__cockpitYouTubeExitUrl");
    const applyStyle = () => {
      const parent = document.head || document.documentElement;
      if (!parent) return false;
      const styleId = "cockpit-youtube-remote-style";
      let style = document.getElementById(styleId);
      if (!style) {
        style = document.createElement("style");
        style.id = styleId;
        parent.append(style);
      }
      style.textContent = ${JSON.stringify(css)};
      return true;
    };
    if (!applyStyle()) document.addEventListener("readystatechange", applyStyle, { once: true });
    ${javascript}
  })();`;
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome WebSocket timed out")), 2000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Chrome WebSocket connection failed"));
    }, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  });
  socket.addEventListener("close", () => {
    for (const { reject } of pending.values()) reject(new Error("Chrome WebSocket closed"));
    pending.clear();
    if (activeClient?.socket === socket) activeClient = null;
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 2000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return { socket, send };
}

async function getClient() {
  if (activeClient?.socket.readyState === WebSocket.OPEN) return activeClient;
  const targets = await readJson(`${debugBaseUrl}/json/list`);
  const target = targets.find((item) => {
    if (item.type !== "page") return false;
    try {
      return /(^|\.)youtube\.com$/.test(new URL(item.url).hostname);
    } catch {
      return false;
    }
  });
  if (!target) throw new Error("YouTube Remote is not running");
  activeClient = await connect(target.webSocketDebuggerUrl);
  const layoutSource = buildLayoutBootstrap();
  await activeClient.send("Page.enable");
  await activeClient.send("Page.addScriptToEvaluateOnNewDocument", { source: layoutSource });
  await activeClient.send("Runtime.evaluate", { expression: layoutSource, awaitPromise: true });
  return activeClient;
}

function controlExpression(payload) {
  return `(() => {
    const request = ${JSON.stringify(payload)};
    const action = request.action;
    const video = document.querySelector("video");
    const selectedAttribute = "data-cockpit-selected";
    const layoutStorageKey = "cockpitYouTubeLayout";

    const applyLayout = () => {
      const layout = "focus";
      const installation = globalThis.__cockpitYouTubeRemoteInstallation;
      if (typeof installation?.applyLayout === "function") installation.applyLayout(layout);
      else {
        localStorage.setItem(layoutStorageKey, layout);
        document.documentElement.dataset.cockpitYoutubeLayout = layout;
        document.documentElement.classList.add("cockpit-youtube-focus-zoom");
        document.body?.classList.remove("cockpit-youtube-layout-tv");
        document.body?.classList.remove("cockpit-youtube-layout-touch");
        document.body?.classList.add("cockpit-youtube-focus-zoom");
      }
      document.querySelectorAll('[' + selectedAttribute + ']').forEach((item) => item.removeAttribute(selectedAttribute));
      scrollTo({ top: 0, behavior: "auto" });
      return layout;
    };
    let activeLayout = "focus";

    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 80 && rect.height > 45 && style.visibility !== "hidden" && style.display !== "none";
    };
    // The focused card is visually transformed. Never use that transformed
    // rectangle for navigation or one key press can change the row model
    // instead of moving selection. Measurement mode synchronously exposes
    // YouTube's original layout geometry without a visible frame change.
    const withStableGeometry = (callback) => {
      const zoomedHosts = Array.from(document.querySelectorAll('[data-cockpit-zoom-positioned="true"]'));
      const savedStyles = zoomedHosts.map((host) => ({
        host,
        transform: host.style.getPropertyValue("transform"),
        transformPriority: host.style.getPropertyPriority("transform"),
        transition: host.style.getPropertyValue("transition"),
        transitionPriority: host.style.getPropertyPriority("transition")
      }));
      document.documentElement.classList.add("cockpit-youtube-measuring");
      zoomedHosts.forEach((host) => {
        host.style.setProperty("transform", "none", "important");
        host.style.setProperty("transition", "none", "important");
      });
      try {
        return callback();
      } finally {
        savedStyles.forEach(({ host, transform, transformPriority, transition, transitionPriority }) => {
          if (transform) host.style.setProperty("transform", transform, transformPriority);
          else host.style.removeProperty("transform");
          if (transition) host.style.setProperty("transition", transition, transitionPriority);
          else host.style.removeProperty("transition");
        });
        document.documentElement.classList.remove("cockpit-youtube-measuring");
      }
    };
    const selectableItems = () => {
      const bestByUrl = new Map();
      Array.from(document.querySelectorAll([
        'a[href*="/watch"]',
        'a[href*="/shorts/"]',
        'a[href*="/playables/"]'
      ].join(','))).forEach((element) => {
        const key = element.href || element.getAttribute("href");
        if (!key || !visible(element)) return;
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        const current = bestByUrl.get(key);
        if (!current || area > current.area) bestByUrl.set(key, { element, area });
      });
      return Array.from(bestByUrl.values(), (entry) => entry.element);
    };
    const markSelected = (element) => {
      document.querySelectorAll('[' + selectedAttribute + ']').forEach((item) => item.removeAttribute(selectedAttribute));
      if (!element) return null;
      element.setAttribute(selectedAttribute, "true");
      const installation = globalThis.__cockpitYouTubeRemoteInstallation;
      if (installation) installation.selectedUrl = element.href || element.getAttribute("href") || "";
      element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
      requestAnimationFrame(() => {
        globalThis.__cockpitYouTubeRemoteInstallation?.positionZoomHost?.(element);
      });
      return element;
    };
    const currentSelection = (items) => {
      const current = document.querySelector('[' + selectedAttribute + ']');
      if (current && items.includes(current)) return current;
      const rememberedUrl = globalThis.__cockpitYouTubeRemoteInstallation?.selectedUrl;
      const remembered = rememberedUrl && items.find((item) => (item.href || item.getAttribute("href")) === rememberedUrl);
      if (remembered) return markSelected(remembered);
      // DOM order is not visual order on YouTube search pages: Shorts shelves
      // can appear before the regular result renderer in the document even
      // when they are lower on screen. Pick the visually top-left candidate
      // so the first Down press never jumps past the search results.
      const inViewport = items
        .map((item) => ({ item, rect: item.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > 90 && rect.top < innerHeight - 40)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0]?.item;
      return markSelected(inViewport || items[0]);
    };
    const buildRows = (items) => {
      const rows = [];
      const sorted = items.map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      for (const entry of sorted) {
        const toleranceFor = (row) => Math.max(34, Math.min(92, Math.min(entry.rect.height, row.height) * 0.34));
        let row = rows.find((candidate) => Math.abs(entry.rect.top - candidate.top) <= toleranceFor(candidate));
        if (!row) {
          row = { top: entry.rect.top, height: entry.rect.height, entries: [] };
          rows.push(row);
        }
        row.entries.push(entry);
        const count = row.entries.length;
        row.top = ((row.top * (count - 1)) + entry.rect.top) / count;
        row.height = Math.max(row.height, entry.rect.height);
      }
      rows.sort((a, b) => a.top - b.top);
      rows.forEach((row) => row.entries.sort((a, b) => a.rect.left - b.rect.left));
      return rows;
    };
    const moveSelection = (direction) => {
      const items = withStableGeometry(selectableItems);
      const current = currentSelection(items);
      if (!current) return false;
      const result = withStableGeometry(() => {
        const source = current.getBoundingClientRect();
        const sx = source.left + source.width / 2;
        const rows = buildRows(items);
        const rowIndex = rows.findIndex((row) => row.entries.some((entry) => entry.element === current));
        if (rowIndex < 0) return { target: current };
        const row = rows[rowIndex];
        const columnIndex = row.entries.findIndex((entry) => entry.element === current);

        if (direction === "left" || direction === "right") {
          const delta = direction === "left" ? -1 : 1;
          const target = row.entries[Math.max(0, Math.min(row.entries.length - 1, columnIndex + delta))];
          return { target: target?.element || current };
        }

        const nextRowIndex = rowIndex + (direction === "up" ? -1 : 1);
        const nextRow = rows[nextRowIndex];
        if (!nextRow) return { scroll: (direction === "up" ? -1 : 1) * innerHeight * 0.72 };

        // Vertical movement always targets the adjacent visual row and keeps
        // the nearest X position, even for short shelves and Playables.
        const target = nextRow.entries.reduce((best, entry) => {
          const center = entry.rect.left + entry.rect.width / 2;
          const distance = Math.abs(center - sx);
          return !best || distance < best.distance ? { entry, distance } : best;
        }, null);
        return { target: target?.entry.element || current };
      });
      if (result.scroll) {
        scrollBy({ top: result.scroll, behavior: "auto" });
        return true;
      }
      return Boolean(markSelected(result.target));
    };

    switch (action) {
      case "home": {
        const destinations = {
          history: "https://www.youtube.com/feed/history",
          playlists: "https://www.youtube.com/feed/playlists",
          subscriptions: "https://www.youtube.com/feed/subscriptions"
        };
        location.assign(destinations[request.query] || "https://www.youtube.com/");
        break;
      }
      case "back": history.back(); break;
      case "search": {
        // A same-query menu search may not create a new document. Clear the
        // previous card explicitly so its remembered Shorts URL cannot become
        // the starting point of the new result set.
        document.querySelectorAll('[' + selectedAttribute + ']').forEach((item) => item.removeAttribute(selectedAttribute));
        const installation = globalThis.__cockpitYouTubeRemoteInstallation;
        if (installation) installation.selectedUrl = "";
        scrollTo({ top: 0, left: 0, behavior: "auto" });
        location.assign("https://www.youtube.com/results?search_query=" + encodeURIComponent(request.query || ""));
        break;
      }
      case "top": scrollTo({ top: 0, behavior: "auto" }); break;
      case "scroll_up": scrollBy({ top: -innerHeight * 0.78, behavior: "auto" }); break;
      case "scroll_down": scrollBy({ top: innerHeight * 0.78, behavior: "auto" }); break;
      case "focus_up": moveSelection("up"); break;
      case "focus_down": moveSelection("down"); break;
      case "focus_left": moveSelection("left"); break;
      case "focus_right": moveSelection("right"); break;
      case "select": currentSelection(withStableGeometry(selectableItems))?.click(); break;
      case "play_pause": if (video) video.paused ? video.play() : video.pause(); break;
      // Disconnect/refresh cleanup must be idempotent. Unlike play_pause this
      // can never accidentally resume a video that is already paused.
      case "pause": if (video && !video.paused) video.pause(); break;
      case "seek_back": if (video) video.currentTime = Math.max(0, video.currentTime - 10); break;
      case "seek_forward": if (video) video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); break;
      case "previous": document.querySelector(".ytp-prev-button")?.click(); break;
      case "next": document.querySelector(".ytp-next-button")?.click(); break;
      case "volume_down": if (video) { video.muted = false; video.volume = Math.max(0, video.volume - 0.1); } break;
      case "volume_up": if (video) { video.muted = false; video.volume = Math.min(1, video.volume + 0.1); } break;
      case "mute": if (video) video.muted = !video.muted; break;
      case "captions": document.querySelector(".ytp-subtitles-button")?.click(); break;
      case "fullscreen": document.querySelector(".ytp-fullscreen-button")?.click(); break;
      case "layout": activeLayout = applyLayout(request.query); break;
      default: throw new Error("Unsupported YouTube action");
    }

    return {
      ok: true,
      action,
      status: {
        title: document.title.replace(/\\s*-\\s*YouTube$/, ""),
        paused: video ? video.paused : null,
        currentTime: video ? Math.round(video.currentTime || 0) : null,
        duration: video && Number.isFinite(video.duration) ? Math.round(video.duration) : null,
        volume: video ? Math.round(video.volume * 100) : null,
        muted: video ? video.muted : null,
        layout: activeLayout
      }
    };
  })()`;
}

async function runControl(payload) {
  const client = await getClient();
  if (payload.action === "home") {
    const destinations = {
      history: "https://www.youtube.com/feed/history",
      playlists: "https://www.youtube.com/feed/playlists",
      subscriptions: "https://www.youtube.com/feed/subscriptions"
    };
    const url = destinations[payload.query] || "https://www.youtube.com/";
    await client.send("Page.navigate", { url });
    return { ok: true, action: "home", destination: payload.query || "home" };
  }
  const response = await client.send("Runtime.evaluate", {
    expression: controlExpression(payload),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "YouTube command failed");
  return response.result?.value || { ok: true, action: payload.action };
}

function stopYouTube() {
  const child = spawn(stopScript, [], { detached: true, stdio: ["ignore", 1, 2] });
  child.unref();
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1:9228");
  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (url.pathname === "/attach" && request.method === "POST" && request.headers["x-cockpit-control-token"] === expectedToken) {
    getClient().then(
      () => sendJson(response, 200, { ok: true, attached: true }),
      (error) => sendJson(response, 503, { ok: false, error: error.message })
    );
    return;
  }
  if (url.pathname !== "/control" || request.method !== "POST" || request.headers["x-cockpit-control-token"] !== expectedToken) {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4096) request.destroy();
  });
  request.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      sendJson(response, 400, { ok: false, error: "invalid_json" });
      return;
    }
    if (!allowedActions.has(payload.action) || (payload.query && String(payload.query).length > 200)) {
      sendJson(response, 400, { ok: false, error: "invalid_action" });
      return;
    }
    if (payload.action === "exit") {
      sendJson(response, 200, { ok: true, action: "exit" });
      setTimeout(stopYouTube, 50);
      return;
    }

    controlQueue = controlQueue.catch(() => undefined).then(() => runControl(payload));
    controlQueue.then(
      (result) => sendJson(response, 200, result),
      (error) => sendJson(response, 503, { ok: false, error: error.message })
    );
  });
});

server.listen(9228, "127.0.0.1", () => {
  console.log("YouTube Remote control helper listening on 127.0.0.1:9228");
});
