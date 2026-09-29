(() => {
  "use strict";

  const PANEL_ID = "treasury-sync-runner";
  const ACTION_TEXT = "司库支付状态同步";
  const BILL_RE = /\b36P5\d{16}\b/i;
  const state = {
    status: "idle",
    processed: new Set(),
    failed: new Set(),
    seen: new Set(),
    current: null,
    totalAtStart: 0,
    expectedTotal: null,
    scrollHost: null,
    stopRequested: false,
    panel: null,
    observer: null,
    updateTimer: null,
  };

  function normalize(value) {
    return String(value || "").replace(/\s+/g, "").trim();
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function getBillNo(element) {
    const row = element.closest("tr") || element.closest("[role='row']") || element.parentElement;
    const match = (row?.innerText || "").match(BILL_RE);
    if (match) return match[0];
    const stableText = normalize(row?.innerText || element.textContent);
    return stableText ? `row-${stableText.slice(0, 180)}` : `row-unknown-${state.seen.size}`;
  }

  function findActionLinks() {
    return Array.from(document.querySelectorAll("a, button, [role='button']")).filter((element) => {
      if (element.closest(`#${PANEL_ID}`)) return false;
      return normalize(element.textContent) === ACTION_TEXT;
    });
  }

  function pendingLinks() {
    const entries = [];
    const currentIds = new Set();
    for (const link of findActionLinks()) {
      const billNo = getBillNo(link);
      state.seen.add(billNo);
      if (currentIds.has(billNo)) continue;
      currentIds.add(billNo);
      if (!state.processed.has(billNo) && !state.failed.has(billNo)) entries.push({ link, billNo });
    }
    // Read the rendered rows from bottom to top so each visible batch is
    // processed in reverse table order.
    return entries.reverse();
  }

  function readExpectedTotal() {
    const text = document.body?.innerText || "";
    const pager = text.match(/共\s*([\d,]+)\s*条/);
    if (pager) return Number(pager[1].replace(/,/g, ""));
    const selectedTab = Array.from(document.querySelectorAll("[role='tab'], .u-tabs-tab, .ant-tabs-tab"))
      .find((element) => element.getAttribute("aria-selected") === "true" || element.classList.contains("active"));
    const tabCount = selectedTab?.innerText.match(/\(\s*([\d,]+)\s*\)/);
    return tabCount ? Number(tabCount[1].replace(/,/g, "")) : null;
  }

  function findScrollHost() {
    if (state.scrollHost?.isConnected) return state.scrollHost;
    let element = findActionLinks()[0]?.parentElement;
    while (element && element !== document.body && element !== document.documentElement) {
      const style = getComputedStyle(element);
      if (/(auto|scroll|overlay|hidden)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 40) {
        state.scrollHost = element;
        return element;
      }
      element = element.parentElement;
    }
    const documentScroller = document.scrollingElement;
    if (documentScroller && documentScroller.scrollHeight > documentScroller.clientHeight + 40) {
      state.scrollHost = documentScroller;
      return documentScroller;
    }
    return null;
  }

  async function scrollForNextBatch() {
    const host = findScrollHost();
    if (!host) return false;
    const maxTop = Math.max(0, host.scrollHeight - host.clientHeight);
    const currentTop = host.scrollTop;
    if (currentTop <= 4) {
      host.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(1200);
      return pendingLinks().length > 0;
    }
    const step = Math.max(260, Math.floor(host.clientHeight * 0.72));
    host.scrollTop = Math.max(0, currentTop - step);
    host.dispatchEvent(new Event("scroll", { bubbles: true }));
    log(`滚动列表加载下一批（已识别 ${state.seen.size}${state.expectedTotal === null ? "" : `/${state.expectedTotal}`} 条）`);
    await sleep(650);
    return true;
  }

  async function moveToListEnd() {
    const host = findScrollHost();
    if (!host) return false;

    // Scan from the top in overlapping increments so virtualized rows are
    // actually rendered and collected before we permit a reverse-order run.
    host.scrollTop = 0;
    host.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(700);
    pendingLinks();

    let previousTop = -1;
    let stableAtEnd = 0;
    for (let attempt = 0; attempt < 1200 && !state.stopRequested; attempt += 1) {
      const maxTop = Math.max(0, host.scrollHeight - host.clientHeight);
      if (host.scrollTop < maxTop - 4) {
        const step = Math.max(220, Math.floor(host.clientHeight * 0.65));
        host.scrollTop = Math.min(maxTop, host.scrollTop + step);
        host.dispatchEvent(new Event("scroll", { bubbles: true }));
        await sleep(450);
        pendingLinks();
        updatePanel();
        stableAtEnd = 0;
      } else {
        await sleep(550);
        pendingLinks();
        const nextMaxTop = Math.max(0, host.scrollHeight - host.clientHeight);
        const atEnd = host.scrollTop >= nextMaxTop - 4;
        const noGrowth = Math.abs(nextMaxTop - maxTop) < 4;
        stableAtEnd = atEnd && noGrowth && Math.abs(host.scrollTop - previousTop) < 4
          ? stableAtEnd + 1
          : 0;
        previousTop = host.scrollTop;
        updatePanel();

        if (stableAtEnd >= 3) {
          await sleep(700);
          pendingLinks();
          updatePanel();
          return true;
        }
      }
    }
    return false;
  }

  function $id(id) {
    return state.panel?.querySelector(`#${id}`);
  }

  function setText(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  function log(message, kind = "info") {
    const box = $id("ts-log");
    if (!box) return;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const item = document.createElement("div");
    item.className = `ts-log-${kind}`;
    item.textContent = `[${time}] ${message}`;
    box.prepend(item);
    while (box.children.length > 40) box.lastElementChild.remove();
  }

  function updatePanel() {
    if (!state.panel) return;
    const available = pendingLinks().length;
    const total = state.expectedTotal ?? readExpectedTotal();
    const statusLabels = {
      idle: "待开始",
      running: "运行中",
      paused: "已暂停",
      stopping: "正在停止",
      done: "已完成",
      incomplete: "需核对",
    };
    setText($id("ts-status"), statusLabels[state.status] || state.status);
    $id("ts-status").dataset.status = state.status;
    const scope = total === null ? `已识别 ${state.seen.size} 条` : `已识别 ${state.seen.size}/${total} 条`;
    setText($id("ts-count"), `${state.processed.size} 已点击 / ${state.failed.size} 异常 / ${available} 当前待点 · ${scope}`);
    setText($id("ts-current"), state.current ? `当前：${state.current}` : "当前：—");
    $id("ts-start").disabled = ["running", "paused", "stopping"].includes(state.status);
    $id("ts-pause").disabled = !["running", "paused"].includes(state.status);
    setText($id("ts-pause"), state.status === "paused" ? "继续" : "暂停");
    $id("ts-stop").disabled = !["running", "paused", "stopping"].includes(state.status);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitWhilePaused() {
    while (state.status === "paused" && !state.stopRequested) {
      await sleep(250);
    }
  }

  function findVisibleErrorToast() {
    const selectors = [
      ".ant-message-error",
      ".ant-notification-notice-error",
      ".u-message-error",
      ".nc-message-error",
      "[class*='message-error']",
      "[class*='notification-error']",
    ];
    return Array.from(document.querySelectorAll(selectors.join(","))).find(isVisible) || null;
  }

  function humanClick(element) {
    element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    element.focus({ preventScroll: true });
    const rect = element.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: 1,
    };
    element.dispatchEvent(new MouseEvent("mouseenter", init));
    element.dispatchEvent(new MouseEvent("mouseover", init));
    element.dispatchEvent(new MouseEvent("mousedown", init));
    element.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
    element.click();
    element.dispatchEvent(new MouseEvent("mouseout", { ...init, buttons: 0 }));
  }

  function readDelay() {
    const seconds = Number($id("ts-delay")?.value || 4);
    return Math.max(1, Math.min(60, seconds)) * 1000;
  }

  async function processOne(link) {
    const billNo = getBillNo(link);
    state.current = billNo;
    updatePanel();
    log(`点击 ${billNo}`);

    const oldError = findVisibleErrorToast();
    humanClick(link);

    const baseDelay = readDelay();
    const jitter = Math.round(Math.random() * Math.min(1200, baseDelay * 0.25));
    await sleep(baseDelay + jitter);

    const newError = findVisibleErrorToast();
    if (newError && newError !== oldError) {
      state.failed.add(billNo);
      log(`${billNo} 检测到错误提示：${newError.textContent.trim().slice(0, 120)}`, "error");
      if ($id("ts-stop-on-error").checked) {
        state.stopRequested = true;
        state.status = "stopping";
      }
      return;
    }

    state.processed.add(billNo);
    log(`${billNo} 已完成一次点击`, "success");
  }

  async function run() {
    if (["running", "paused", "stopping"].includes(state.status)) return;
    state.expectedTotal = readExpectedTotal();
    state.scrollHost = findScrollHost();
    let links = pendingLinks();
    if (!links.length) {
      log("当前页面没有可处理的“司库支付状态同步”链接", "error");
      return;
    }

    const expectedLabel = state.expectedTotal === null ? `当前已加载 ${state.seen.size} 条` : `当前筛选共 ${state.expectedTotal} 条`;
    const ok = window.confirm(
      `即将先从列表顶部逐段扫描到筛选结果末尾，再从最后一行开始向上逐条点击“${ACTION_TEXT}”。\n\n` +
      `${expectedLabel}；当前 DOM 仅已加载 ${state.seen.size} 条。\n` +
      `扫描过程会累计虚拟列表中的行；定位末尾并确认识别数达到总数后才开始点击，每条间隔 ${readDelay() / 1000} 秒。\n` +
      "执行期间请保持本页打开；可随时暂停或停止。\n\n是否开始？"
    );
    if (!ok) return;

    state.status = "running";
    state.stopRequested = false;
    state.totalAtStart = state.expectedTotal ?? state.seen.size;
    log(`开始定位列表末尾，筛选总数 ${state.expectedTotal ?? "未知"}，初始 DOM 已加载 ${state.seen.size} 条`);
    updatePanel();

    try {
      const reachedEnd = await moveToListEnd();
      if (state.stopRequested) return;
      links = pendingLinks();
      if (!reachedEnd) {
        state.status = "incomplete";
        log("无法确认已到达列表末尾；为避免从中间记录开始，本次未点击任何状态同步链接。", "error");
        return;
      }
      if (state.expectedTotal !== null && state.seen.size < state.expectedTotal) {
        state.status = "incomplete";
        log(`已滚到末尾，但只识别 ${state.seen.size}/${state.expectedTotal} 条；为避免漏单，本次未点击任何状态同步链接。`, "error");
        return;
      }
      if (!links.length) {
        state.status = "incomplete";
        log("到达列表末尾后未找到可处理链接，本次未点击。", "error");
        return;
      }
      log(`已定位列表末尾并核对 ${state.seen.size}${state.expectedTotal === null ? "" : `/${state.expectedTotal}`} 条；开始从末行向上处理。`);

      while (!state.stopRequested) {
        await waitWhilePaused();
        if (state.stopRequested) break;

        const next = pendingLinks()[0];
        if (!next) {
          const advanced = await scrollForNextBatch();
          if (state.stopRequested) break;
          if (pendingLinks().length) continue;
          if (advanced) continue;

          if (state.scrollHost && state.scrollHost.scrollTop <= 4 && state.expectedTotal !== null && state.seen.size >= state.expectedTotal) {
            state.status = "done";
            log(`本页处理完成：已识别 ${state.seen.size}/${state.expectedTotal} 条，已点击 ${state.processed.size} 条，异常 ${state.failed.size} 条`, "success");
          } else if (state.expectedTotal !== null && state.seen.size < state.expectedTotal) {
            state.status = "incomplete";
            log(`已到列表顶部，但只识别 ${state.seen.size}/${state.expectedTotal} 条。为避免误报完成，请核对分页、筛选和列表滚动容器。`, "error");
          } else if (!state.scrollHost || state.scrollHost.scrollTop <= 4) {
            state.status = "done";
            log(`本页处理完成：已识别 ${state.seen.size} 条，已点击 ${state.processed.size} 条，异常 ${state.failed.size} 条`, "success");
          } else {
            continue;
          }
          break;
        }

        await processOne(next.link);
        updatePanel();
      }
    } catch (error) {
      state.status = "paused";
      log(`运行已暂停：${error?.message || error}`, "error");
    } finally {
      if (state.stopRequested) {
        state.status = "idle";
        log("已停止");
      }
      state.current = null;
      state.stopRequested = false;
      updatePanel();
    }
  }

  function mountPanel() {
    if (state.panel || document.getElementById(PANEL_ID)) return;
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <header>
        <strong>司库状态顺序同步</strong>
        <button id="ts-collapse" type="button" title="收起/展开">−</button>
      </header>
      <div id="ts-body">
        <div class="ts-summary">
          <span id="ts-status" data-status="idle">待开始</span>
          <span id="ts-count">正在读取当前列表…</span>
        </div>
        <div id="ts-current">当前：—</div>
        <label class="ts-field">
          <span>每条间隔</span>
          <input id="ts-delay" type="number" min="1" max="60" step="1" value="4">
          <span>秒</span>
        </label>
        <label class="ts-check">
          <input id="ts-stop-on-error" type="checkbox" checked>
          <span>检测到错误提示时停止</span>
        </label>
        <div class="ts-actions">
          <button id="ts-start" type="button">开始</button>
          <button id="ts-pause" type="button" disabled>暂停</button>
          <button id="ts-stop" type="button" disabled>停止</button>
        </div>
        <div id="ts-log" aria-live="polite"></div>
      <p class="ts-note">先从顶部逐段扫描到末尾并核对总数，再从最后一行向上执行；刷新页面会清空本次进度。</p>
      </div>
    `;
    document.documentElement.appendChild(panel);
    state.panel = panel;

    $id("ts-start").addEventListener("click", run);
    $id("ts-pause").addEventListener("click", () => {
      if (state.status === "running") {
        state.status = "paused";
        log("已暂停");
      } else if (state.status === "paused") {
        state.status = "running";
        log("继续运行");
      }
      updatePanel();
    });
    $id("ts-stop").addEventListener("click", () => {
      state.stopRequested = true;
      state.status = "stopping";
      updatePanel();
    });
    $id("ts-collapse").addEventListener("click", () => {
      const body = $id("ts-body");
      const collapsed = body.hidden = !body.hidden;
      $id("ts-collapse").textContent = collapsed ? "+" : "−";
    });
    updatePanel();
    log("插件已就绪");
  }

  function watchForTargetPage() {
    if (findActionLinks().length) mountPanel();
    state.observer = new MutationObserver((records) => {
      const pageChanged = records.some((record) => !state.panel?.contains(record.target));
      if (!pageChanged) return;
      clearTimeout(state.updateTimer);
      state.updateTimer = setTimeout(() => {
        if (!state.panel && findActionLinks().length) mountPanel();
        if (state.panel) updatePanel();
      }, 150);
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  watchForTargetPage();
})();
