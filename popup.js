const statusElement = document.getElementById("status");
const toggleButton = document.getElementById("toggle");
let activeTabId = null;

function showStatus(message, kind = "") {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
}

async function inspectFrames(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const panel = document.getElementById("treasury-sync-runner");
      if (!panel) return null;
      return {
        hidden: panel.hidden || getComputedStyle(panel).display === "none",
        counts: panel.querySelector("#ts-count")?.textContent || "",
      };
    },
  });
}

async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("没有可用的当前标签页");
    activeTabId = tab.id;
    const frames = await inspectFrames(activeTabId);
    const panel = frames.map((frame) => frame.result).find(Boolean);
    if (!panel) {
      showStatus("当前页面还没有检测到控制面板。请打开直联支付列表并刷新页面。", "error");
      toggleButton.textContent = "重新检查";
      toggleButton.disabled = false;
      return;
    }
    showStatus(`扩展已就绪。${panel.counts}`, "ok");
    toggleButton.textContent = panel.hidden ? "显示页面控制面板" : "收起页面控制面板";
    toggleButton.disabled = false;
  } catch (error) {
    showStatus(`检查失败：${error.message || error}`, "error");
    toggleButton.textContent = "重试检查";
    toggleButton.disabled = false;
  }
}

toggleButton.addEventListener("click", async () => {
  if (!activeTabId) return initialize();
  toggleButton.disabled = true;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId, allFrames: true },
      func: () => {
        const panel = document.getElementById("treasury-sync-runner");
        if (!panel) return null;
        panel.hidden = !panel.hidden;
        return {
          hidden: panel.hidden,
          counts: panel.querySelector("#ts-count")?.textContent || "",
        };
      },
    });
    const panel = results.map((frame) => frame.result).find(Boolean);
    if (!panel) throw new Error("当前页面没有控制面板；请先刷新直联支付页面");
    showStatus(`扩展已就绪。${panel.counts}`, "ok");
    toggleButton.textContent = panel.hidden ? "显示页面控制面板" : "收起页面控制面板";
  } catch (error) {
    showStatus(`操作失败：${error.message || error}`, "error");
  } finally {
    toggleButton.disabled = false;
  }
});

initialize();
