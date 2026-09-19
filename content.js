(() => {
  const STATE = {
    enabled: true,
    sensitivity: "medium",
    lastHref: "",
    cooldown: 0,
    stream: null,
    pumping: false,
  };

  function isReelsPath() {
    return /\/reels?(\/|$)/i.test(location.pathname);
  }

  function pageVideos() {
    return [...document.querySelectorAll("video")].filter(
      (v) => v.id !== "gaze-video" && v.offsetHeight > 80,
    );
  }

  function pickVisibleVideo() {
    return pageVideos().find((v) => {
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

    const videos = pageVideos();
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

  function setHint(text) {
    const hint = document.getElementById("gaze-hint");
    if (!hint) return;
    if (!text) {
      hint.hidden = true;
      hint.textContent = "";
      return;
    }
    hint.hidden = false;
    hint.textContent = text;
  }

  function setLabel(text) {
    const label = document.getElementById("gaze-label");
    if (label && STATE.enabled) label.textContent = text;
  }

  function destroy() {
    STATE.stream?.getTracks().forEach((t) => t.stop());
    STATE.stream = null;
    STATE.pumping = false;
    root()?.remove();
  }

  function mount() {
    if (root()) return;
    const wrap = document.createElement("div");
    wrap.id = "gaze-root";
    wrap.innerHTML = `
      <video id="gaze-video" muted playsinline autoplay></video>
      <div id="gaze-hint">Tap to start camera</div>
      <iframe id="gaze-frame" title="Gaze tracker"></iframe>
      <div id="gaze-hud">
        <span id="gaze-label">Gaze</span>
        <button id="gaze-toggle" type="button">On</button>
      </div>
    `;
    document.documentElement.appendChild(wrap);
    document.getElementById("gaze-frame").src = chrome.runtime.getURL("tracker.html");
    wrap.querySelector("#gaze-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.storage.local.set({ enabled: !STATE.enabled });
    });
    wrap.querySelector("#gaze-video").addEventListener("click", () => {
      if (STATE.enabled) startCamera();
    });
    wrap.querySelector("#gaze-hint").addEventListener("click", () => {
      if (STATE.enabled) startCamera();
    });
    syncHud();
    if (STATE.enabled) startCamera();
  }

  function syncHud() {
    const btn = document.getElementById("gaze-toggle");
    if (!btn) return;
    btn.dataset.on = String(STATE.enabled);
    btn.textContent = STATE.enabled ? "On" : "Off";
    if (!STATE.enabled) {
      setLabel("Paused");
      setHint("Paused");
      STATE.stream?.getTracks().forEach((t) => t.stop());
      STATE.stream = null;
      const video = document.getElementById("gaze-video");
      if (video) video.srcObject = null;
    } else if (!STATE.stream) {
      setLabel("Gaze");
      startCamera();
    }
    pushConfig();
  }

  function pushConfig() {
    const iframe = document.getElementById("gaze-frame");
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage(
      { source: "gaze-host", type: "config", enabled: STATE.enabled, sensitivity: STATE.sensitivity },
      "*",
    );
  }

  async function startCamera() {
    if (!STATE.enabled) return;
    setLabel("Camera");
    setHint("Starting…");
    try {
      STATE.stream?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      STATE.stream = stream;
      const video = document.getElementById("gaze-video");
      if (!video) return;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      setHint("");
      setLabel("Loading");
      pushConfig();
      pumpFrames();
    } catch (err) {
      console.warn("Gaze camera", err);
      setLabel("Allow cam");
      setHint("Tap here, then Allow");
    }
  }

  function pumpFrames() {
    if (STATE.pumping) return;
    STATE.pumping = true;
    let last = 0;
    const tick = async (now) => {
      if (!STATE.pumping) return;
      requestAnimationFrame(tick);
      if (!STATE.enabled || !STATE.stream) return;
      if (now - last < 50) return;
      last = now;
      const video = document.getElementById("gaze-video");
      const iframe = document.getElementById("gaze-frame");
      if (!video || video.readyState < 2 || !iframe?.contentWindow) return;
      try {
        const bitmap = await createImageBitmap(video);
        iframe.contentWindow.postMessage(
          {
            source: "gaze-host",
            type: "frame",
            bitmap,
            ts: now,
            enabled: STATE.enabled,
            sensitivity: STATE.sensitivity,
          },
          "*",
          [bitmap],
        );
      } catch {
        /* tracker not ready yet */
      }
    };
    requestAnimationFrame(tick);
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
    if (data.type === "status") setLabel(data.label || "Gaze");
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
  });

  setInterval(onNav, 400);
  onNav();
})();
