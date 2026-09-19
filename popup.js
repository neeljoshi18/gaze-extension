const enabledEl = document.getElementById("enabled");
const sensitivityEl = document.getElementById("sensitivity");
const stateEl = document.getElementById("state");

function paint(enabled) {
  stateEl.textContent = enabled ? "On" : "Off";
  stateEl.style.color = enabled ? "#8fa196" : "#9a9a96";
}

chrome.storage.local.get({ enabled: true, sensitivity: "medium" }, (cur) => {
  enabledEl.checked = cur.enabled !== false;
  sensitivityEl.value = cur.sensitivity || "medium";
  paint(enabledEl.checked);
});

enabledEl.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enabledEl.checked });
  paint(enabledEl.checked);
});

sensitivityEl.addEventListener("change", () => {
  chrome.storage.local.set({ sensitivity: sensitivityEl.value });
});
