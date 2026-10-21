function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#6e7781" });
}

chrome.storage.sync.get({ enabled: true }, ({ enabled }) => updateBadge(enabled));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && "enabled" in changes) updateBadge(changes.enabled.newValue !== false);
});
