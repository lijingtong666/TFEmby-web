const form = document.querySelector("#configForm");
const toast = document.querySelector("#toast");
const runStatus = document.querySelector("#runStatus");
const appVersion = document.querySelector("#appVersion");
const logsEl = document.querySelector("#logs");

const fields = [
  "telegramBotToken",
  "telegramChatId",
  "tmdbApiKey",
  "tmdbLanguage",
  "embyUrl",
  "embyApiKey",
  "embyUserId",
  "publicBaseUrl",
  "webhookSecret",
  "pollIntervalSeconds",
  "latestLimit",
  "overviewMaxLength",
  "monitoredEvents",
  "notifyFirstRun",
  "doubanFallbackEnabled",
  "enableCovers",
  "proxyEnabled",
  "proxyUrl",
];

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败：${res.status}`);
  }
  return data;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function readConfigFromForm() {
  const data = {};
  for (const name of fields) {
    const el = form.elements[name];
    if (!el) continue;
    if (el.type === "checkbox") {
      data[name] = el.checked;
    } else if (el.type === "number") {
      data[name] = Number(el.value);
    } else {
      data[name] = el.value.trim();
    }
  }
  data.includeTypes = [...form.querySelectorAll('input[name="includeTypes"]:checked')].map((el) => el.value);
  return data;
}

function fillForm(config) {
  for (const name of fields) {
    const el = form.elements[name];
    if (!el) continue;
    if (el.type === "checkbox") {
      el.checked = Boolean(config[name]);
    } else {
      el.value = config[name] ?? "";
    }
  }
  const types = new Set(config.includeTypes || []);
  form.querySelectorAll('input[name="includeTypes"]').forEach((el) => {
    el.checked = types.has(el.value);
  });
  renderWebhookHelp(config);
}

async function loadConfig() {
  const data = await api("/api/config");
  fillForm(data.config);
}

function renderStatus(status) {
  runStatus.textContent = status.running ? "运行中" : "未运行";
  runStatus.classList.toggle("running", status.running);
  if (appVersion) {
    appVersion.textContent = `v${status.version || "-"}`;
  }
  document.querySelector("#seenCount").textContent = status.seenCount ?? 0;
  document.querySelector("#quickSeen").textContent = status.seenCount ?? 0;
  document.querySelector("#quickWebhook").textContent = status.lastWebhookAt || "等待事件";
  document.querySelector("#quickSummary").textContent = status.lastSummary || "暂无入库通知";
  document.querySelector("#lastTickAt").textContent = status.lastTickAt || "-";
  document.querySelector("#lastWebhookAt").textContent = status.lastWebhookAt || "-";
  document.querySelector("#lastScanAt").textContent = status.lastScanAt || "-";
  document.querySelector("#lastSummary").textContent = status.lastSummary || "-";
  document.querySelector("#lastError").textContent = status.lastError || "-";
  document.querySelector("#lastErrorWrap").style.display = status.lastError ? "block" : "none";
  const logs = status.logs || [];
  logsEl.innerHTML = logs.length
    ? logs.map((line) => `<div class="log-line">[${escapeHtml(line.at)}] ${escapeHtml(line.message)}</div>`).join("")
    : '<div class="log-line">暂无日志</div>';
  logsEl.scrollTop = logsEl.scrollHeight;
}

async function loadStatus() {
  const data = await api("/api/status");
  renderStatus(data.status);
}

async function saveConfig() {
  const config = readConfigFromForm();
  const data = await api("/api/config", {
    method: "POST",
    body: JSON.stringify({ config }),
  });
  fillForm(data.config);
  showToast("配置已保存");
  await loadStatus();
}

function renderWebhookHelp(config = readConfigFromForm()) {
  const secret = config.webhookSecret ? `?token=${encodeURIComponent(config.webhookSecret)}` : "";
  const baseUrl = (config.publicBaseUrl || window.location.origin).replace(/\/+$/, "");
  const webhookUrl = `${baseUrl}/webhook/emby${secret}`;
  document.querySelector("#webhookUrl").value = webhookUrl;
  document.querySelector("#webhookTemplate").textContent = JSON.stringify(
    {
      event: "{Event}",
      item_id: "{ItemId}",
      item_name: "{ItemName}",
      item_type: "{ItemType}",
      series_name: "{SeriesName}",
      date_added: "{ItemDateAdded}",
      timestamp: "{Timestamp}",
    },
    null,
    2,
  );
}

async function runAction(label, fn) {
  try {
    await fn();
  } catch (err) {
    showToast(err.message, true);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction("save", saveConfig);
});

document.querySelector("#reloadBtn").addEventListener("click", () => runAction("reload", loadConfig));
form.addEventListener("input", () => renderWebhookHelp());
document.querySelector("#copyWebhookBtn").addEventListener("click", () =>
  runAction("copy", async () => {
    const input = document.querySelector("#webhookUrl");
    input.focus();
    input.select();
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(input.value);
      } else if (!document.execCommand("copy")) {
        throw new Error("copy fallback failed");
      }
      showToast("Webhook URL 已复制");
    } catch (err) {
      showToast("已选中 URL，请手动复制");
    }
  }),
);
document.querySelector("#startBtn").addEventListener("click", () =>
  runAction("start", async () => {
    await api("/api/start", { method: "POST", body: "{}" });
    showToast("备用轮询已启动");
    await loadStatus();
  }),
);
document.querySelector("#stopBtn").addEventListener("click", () =>
  runAction("stop", async () => {
    await api("/api/stop", { method: "POST", body: "{}" });
    showToast("备用轮询已停止");
    await loadStatus();
  }),
);
document.querySelector("#scanBtn").addEventListener("click", () =>
  runAction("scan", async () => {
    const data = await api("/api/scan", { method: "POST", body: "{}" });
    showToast(data.result.summary);
    await loadStatus();
  }),
);
document.querySelector("#clearSeenBtn").addEventListener("click", () =>
  runAction("clear", async () => {
    const ok = window.confirm("清空后，下次扫描会重新按首次扫描规则处理当前最新项目。");
    if (!ok) return;
    await api("/api/clear-seen", { method: "POST", body: "{}" });
    showToast("通知记录已清空");
    await loadStatus();
  }),
);

for (const [id, target] of [
  ["testAllBtn", "all"],
  ["testEmbyBtn", "emby"],
  ["testTmdbBtn", "tmdb"],
  ["testDoubanBtn", "douban"],
  ["testTgBtn", "telegram"],
]) {
  document.querySelector(`#${id}`).addEventListener("click", () =>
    runAction(target, async () => {
      await saveConfig();
      const data = await api("/api/test", {
        method: "POST",
        body: JSON.stringify({ target }),
      });
      showToast(data.messages.join("；"));
      await loadStatus();
    }),
  );
}

async function boot() {
  try {
    await loadConfig();
    await loadStatus();
    setInterval(() => loadStatus().catch(() => {}), 5000);
  } catch (err) {
    showToast(err.message, true);
  }
}

boot();
