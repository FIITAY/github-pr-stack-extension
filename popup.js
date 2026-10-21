const checkbox = document.getElementById("enabled");
const status = document.getElementById("status");

function render(enabled) {
  checkbox.checked = enabled;
  status.textContent = enabled ? "On for github.com" : "Off. The PR list is shown unchanged.";
}

chrome.storage.sync.get({ enabled: true }, ({ enabled }) => render(enabled));
checkbox.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: checkbox.checked });
  render(checkbox.checked);
});
