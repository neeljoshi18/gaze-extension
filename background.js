chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-gaze") return;
  chrome.storage.local.get({ enabled: true }, ({ enabled }) => {
    chrome.storage.local.set({ enabled: !enabled });
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ enabled: true, sensitivity: "medium" }, (cur) => {
    chrome.storage.local.set({
      enabled: cur.enabled !== false,
      sensitivity: cur.sensitivity || "medium",
    });
  });
});
