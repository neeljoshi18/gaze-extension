(() => {
  const STATE = { enabled: true, sensitivity: "medium", lastHref: "", cooldown: 0 };

  function isReelsPath() {
    return /\/reels?(\/|$)/i.test(location.pathname);
  }

  function pickVisibleVideo() {
    const videos = [...document.querySelectorAll("video")].filter((v) => v.offsetHeight > 80);
    return videos.find((v) => {
      const r = v.getBoundingClientRect();
      return r.height > window.innerHeight * 0.35 && r.top < window.innerHeight * 0.6 && r.bottom > window.innerHeight * 0.3;
    });
  }

  function findScroller(from) {
    let n = from?.parentElement;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      const scrollable = n.scrollHeight > n.clientHeight + 80;
      const oy = s.overflowY;
      const snap = s.scrollSnapType || "";
      if (scrollable && (oy === "auto" || oy === "scroll" || oy === "overlay" || snap.includes("y"))) {
        return n;
      }
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollReels(dir) {
    const now = Date.now();
    if (now < STATE.cooldown) return;
    STATE.cooldown = now + 700;

    const videos = [...document.querySelectorAll("video")].filter((v) => v.offsetHeight > 80);
    const vis = videos.findIndex((v) => {
      const r = v.getBoundingClientRect();
      return r.top < window.innerHeight * 0.55 && r.bottom > window.innerHeight * 0.35;
    });
    if (vis >= 0) {
      const target = videos[vis + (dir === "next" ? 1 : -1)];
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
    const scroller = findScroller(pickVisibleVideo());
    const h = Math.round((scroller.clientHeight || window.innerHeight) * 0.95);
    scroller.scrollBy({ top: dir === "next" ? h : -h, behavior: "smooth" });
  }

  function root() {
    return document.getElementById("gaze-root");
  }

  function destroy() {
    root()?.remove();
  }

  function mount() {
    if (root()) return;
    const wrap = document.createElement("div");
    wrap.id = "gaze-root";
    wrap.innerHTML = `
      <iframe id="gaze-frame" title="Gaze camera" allow="camera *"></iframe>
      <div id="gaze-hud">
        <span id="gaze-label">Gaze</span>
        <button id="gaze-toggle" type="button">On</button>
      </div>
    `;
    document.documentElement.appendChild(wrap);
    const iframe = wrap.querySelector("#gaze-frame");
    iframe.setAttribute("allow", "camera *;");
    iframe.allow = "camera";
    iframe.src = chrome.runtime.getURL("tracker.html");
    wrap.querySelector("#gaze-toggle").addEventListener("click", () => {
      chrome.storage.local.set({ enabled: !STATE.enabled });
    });
    syncHud();
    pushConfig();
  }

  function syncHud() {
    const btn = document.getElementById("gaze-toggle");
    const label = document.getElementById("gaze-label");
    if (!btn || !label) return;
    btn.dataset.on = String(STATE.enabled);
    btn.textContent = STATE.enabled ? "On" : "Off";
    label.textContent = STATE.enabled ? "Gaze" : "Paused";
  }

  function pushConfig() {
    const iframe = document.getElementById("gaze-frame");
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      { source: "gaze-host", enabled: STATE.enabled, sensitivity: STATE.sensitivity },
      "*",
    );
  }

  function onNav() {
    if (location.href === STATE.lastHref) return;
    STATE.lastHref = location.href;
    if (isReelsPath()) mount();
    else destroy();
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.source !== "gaze") return;
    if (data.type === "scroll" && STATE.enabled) scrollReels(data.dir);
    if (data.type === "ready") pushConfig();
    if (data.type === "status") {
      const label = document.getElementById("gaze-label");
      if (label && STATE.enabled) label.textContent = data.label || "Gaze";
    }
  });

  chrome.storage.local.get({ enabled: true, sensitivity: "medium" }, (cur) => {
    STATE.enabled = cur.enabled !== false;
    STATE.sensitivity = cur.sensitivity || "medium";
    onNav();
    syncHud();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) STATE.enabled = changes.enabled.newValue !== false;
    if (changes.sensitivity) STATE.sensitivity = changes.sensitivity.newValue || "medium";
    syncHud();
    pushConfig();
  });

  setInterval(onNav, 400);
  onNav();
})();
