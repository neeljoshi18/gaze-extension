import { FaceLandmarker } from "./mediapipe/vision_bundle.mjs";

const SENSITIVITY = {
  low: { eye: 0.5, head: 0.2, holdMs: 420, cooldownMs: 1450, stillStd: 0.02 },
  medium: { eye: 0.34, head: 0.12, holdMs: 260, cooldownMs: 1100, stillStd: 0.028 },
  high: { eye: 0.22, head: 0.075, holdMs: 150, cooldownMs: 820, stillStd: 0.04 },
};

function stddev(values) {
  if (values.length < 4) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function blend(shapes, name) {
  if (!shapes) return 0;
  return shapes.find((c) => c.categoryName === name)?.score ?? 0;
}

function sampleFromResult(result) {
  const landmarks = result?.faceLandmarks?.[0];
  if (!landmarks?.length) return null;
  const shapes = result?.faceBlendshapes?.[0]?.categories;
  const matrix = result?.facialTransformationMatrixes?.[0]?.data;
  const pitch = matrix && matrix.length > 6 ? Math.asin(clamp(-matrix[6], -1, 1)) : 0;
  const iris = (axis(landmarks[468], landmarks[159], landmarks[145]) + axis(landmarks[473], landmarks[386], landmarks[374])) / 2;
  return {
    present: true,
    headPitch: pitch,
    eyeLookDown: (blend(shapes, "eyeLookDownLeft") + blend(shapes, "eyeLookDownRight")) / 2,
    eyeLookUp: (blend(shapes, "eyeLookUpLeft") + blend(shapes, "eyeLookUpRight")) / 2,
    irisY: iris,
  };
}

function axis(iris, upper, lower) {
  if (!iris || !upper || !lower) return 0;
  const mid = (upper.y + lower.y) / 2;
  const h = Math.max(1e-5, lower.y - upper.y);
  return (iris.y - mid) / h;
}

class GazeController {
  constructor() {
    this.reset();
  }
  reset() {
    this.baselinePitch = 0;
    this.baselineIris = 0;
    this.pitches = [];
    this.charging = null;
    this.chargeStarted = 0;
    this.cooldownUntil = 0;
    this.needNeutral = false;
    this.calibrated = false;
  }
  calibrate(samples) {
    const present = samples.filter((s) => s.present);
    if (present.length < 8) return;
    const pitches = present.map((s) => s.headPitch).sort((a, b) => a - b);
    const irises = present.map((s) => s.irisY).sort((a, b) => a - b);
    this.baselinePitch = pitches[Math.floor(pitches.length / 2)] ?? 0;
    this.baselineIris = irises[Math.floor(irises.length / 2)] ?? 0;
    this.calibrated = true;
    this.pitches = [];
    this.needNeutral = false;
    this.charging = null;
  }
  update(sample, now, sensitivity) {
    const cfg = SENSITIVITY[sensitivity] || SENSITIVITY.medium;
    const NEUTRAL = 0.14;
    if (!sample?.present) {
      this.charging = null;
      return { mode: "lost", intent: null, reason: null };
    }
    this.pitches.push(sample.headPitch);
    if (this.pitches.length > 18) this.pitches.shift();
    const still = stddev(this.pitches) < cfg.stillStd;
    const netEye = clamp(sample.eyeLookDown - sample.eyeLookUp, -1, 1);
    const iris = clamp((sample.irisY - this.baselineIris) * 2.2, -1, 1);
    const eyeSignal = clamp(netEye * 0.7 + iris * 0.3, -1, 1);
    const headSignal = clamp((sample.headPitch - this.baselinePitch) / Math.max(cfg.head, 0.04), -1.4, 1.4);
    const signal = still ? eyeSignal : headSignal;
    const reason = still ? "eyes" : "face";
    const mode = still ? "eyes" : "face";
    const thresh = still ? 0.85 : 0.9;
    const mag = Math.abs(signal);
    const want = signal > thresh ? "next" : signal < -thresh ? "prev" : null;
    if (now < this.cooldownUntil) return { mode, intent: null, reason: null, label: mode };
    if (this.needNeutral) {
      if (mag < NEUTRAL) this.needNeutral = false;
      return { mode, intent: null, reason: null, label: mode };
    }
    if (!want) {
      this.charging = null;
      return { mode, intent: null, reason: null, label: mode };
    }
    if (this.charging !== want) {
      this.charging = want;
      this.chargeStarted = now;
    }
    if (now - this.chargeStarted < cfg.holdMs) return { mode, intent: null, reason: null, label: mode };
    this.charging = null;
    this.needNeutral = true;
    this.cooldownUntil = now + cfg.cooldownMs;
    return { mode, intent: want, reason, label: mode };
  }
}

const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const controller = new GazeController();
const calib = [];
let landmarker = null;
let lastTs = 0;
let enabled = true;
let sensitivity = "medium";
let status = "boot";
let raf = 0;
let stream = null;

function post(msg) {
  parent.postMessage({ source: "gaze", ...msg }, "*");
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== "gaze-host") return;
  if (typeof data.enabled === "boolean") enabled = data.enabled;
  if (data.sensitivity) sensitivity = data.sensitivity;
  if (!enabled) stop();
  else if (status === "stopped" || status === "boot") start();
});

async function start() {
  status = "starting";
  post({ type: "status", label: "Camera" });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    const fileset = {
      wasmLoaderPath: chrome.runtime.getURL("mediapipe/vision_wasm_internal.js"),
      wasmBinaryPath:
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm/vision_wasm_internal.wasm",
    };
    const opts = (delegate) => ({
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate,
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    try {
      landmarker = await FaceLandmarker.createFromOptions(fileset, opts("GPU"));
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(fileset, opts("CPU"));
    }
    controller.reset();
    calib.length = 0;
    lastTs = 0;
    status = "calibrating";
    post({ type: "status", label: "Calibrate" });
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  } catch (err) {
    status = "error";
    post({ type: "status", label: "Blocked" });
    console.warn("Gaze camera", err);
  }
}

function stop() {
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  landmarker?.close();
  landmarker = null;
  status = "stopped";
  const ctx = canvas.getContext("2d");
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
  post({ type: "status", label: "Paused" });
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (!enabled || !landmarker || video.readyState < 2) return;
  const now = performance.now();
  if (now - lastTs < 33) return;
  const ts = Math.max(lastTs + 1, now);
  lastTs = ts;
  let result;
  try {
    result = landmarker.detectForVideo(video, ts);
  } catch {
    return;
  }
  const sample = sampleFromResult(result);
  if (canvas && video.videoWidth) {
    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (sample) {
        ctx.fillStyle = "#8fa196";
        ctx.beginPath();
        ctx.arc(canvas.width / 2, canvas.height / 2, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  if (status === "calibrating") {
    if (sample?.present) calib.push(sample);
    if (calib.length >= 36) {
      controller.calibrate(calib);
      status = "running";
      post({ type: "status", label: "Eyes" });
    }
    return;
  }
  const frame = controller.update(sample, now, sensitivity);
  if (frame.label) post({ type: "status", label: frame.mode === "lost" ? "Find a face" : frame.mode === "eyes" ? "Eyes" : "Face" });
  if (frame.intent) post({ type: "scroll", dir: frame.intent, reason: frame.reason });
}

post({ type: "ready" });
start();
