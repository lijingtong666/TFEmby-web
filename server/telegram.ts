import { config } from "./config.js";
import type { MediaRequest, RequestStatus } from "./types.js";

type TgBotStatus = {
  version?: string;
  running?: boolean;
  lastTickAt?: string | null;
  lastScanAt?: string | null;
  lastWebhookAt?: string | null;
  lastError?: string;
  lastSummary?: string;
  seenCount?: number;
};

const statusLabels: Record<RequestStatus, string> = {
  pending: "待处理",
  approved: "已接收",
  fulfilled: "已入库",
  rejected: "已拒绝"
};

function escapeHtml(value: string | number | undefined) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}

function chatIds() {
  return config.telegramChatId.split(",").map((item) => item.trim()).filter(Boolean);
}

export function telegramConfigured() {
  return Boolean(config.telegramBotToken && chatIds().length);
}

async function telegramCall(method: "sendMessage" | "sendPhoto", values: Record<string, string>) {
  const response = await fetch(`${config.telegramApiBase}/bot${config.telegramBotToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(10000)
  });
  const result = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
}

async function sendTelegram(message: string, photo?: string) {
  if (!telegramConfigured()) return { configured: false, sent: 0 };
  let sent = 0;
  for (const chatId of chatIds()) {
    if (photo?.startsWith("https://")) {
      try {
        await telegramCall("sendPhoto", { chat_id: chatId, photo, caption: message, parse_mode: "HTML" });
        sent += 1;
        continue;
      } catch {
        // Fall back to a text message if Telegram cannot fetch the remote poster.
      }
    }
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: "true"
    });
    sent += 1;
  }
  return { configured: true, sent };
}

function tmdbUrl(request: MediaRequest) {
  return `https://www.themoviedb.org/${request.mediaType}/${encodeURIComponent(request.tmdbId)}`;
}

export function notifyRequestCreated(request: MediaRequest) {
  const message = [
    "📨 <b>新的求片申请</b>",
    "",
    `<b>提交用户：</b>${escapeHtml(request.requestedBy.username)}`,
    `<b>影片名称：</b>${escapeHtml(request.title)}`,
    `<b>媒体类型：</b>${request.mediaType === "tv" ? "剧集" : "电影"}`,
    `<b>上映年份：</b>${request.year ? escapeHtml(request.year) : "未知"}`,
    `<b>TMDB ID：</b>${escapeHtml(request.tmdbId)}`,
    `<b>详情链接：</b><a href="${tmdbUrl(request)}">打开 TMDB</a>`
  ].join("\n");
  return sendTelegram(message, request.poster);
}

export function notifyRequestStatus(request: MediaRequest, operator: string) {
  const icon = request.status === "fulfilled" ? "✅" : request.status === "rejected" ? "❌" : "🔔";
  const message = [
    `${icon} <b>求片状态更新</b>`,
    "",
    `<b>片名：</b>${escapeHtml(request.title)}`,
    `<b>状态：</b>${statusLabels[request.status]}`,
    `<b>申请人：</b>${escapeHtml(request.requestedBy.username)}`,
    `<b>操作人：</b>${escapeHtml(operator)}`,
    `<b>TMDB：</b><a href="${tmdbUrl(request)}">${escapeHtml(request.tmdbId)}</a>`
  ].join("\n");
  return sendTelegram(message, request.poster);
}

export function sendTelegramTest() {
  return sendTelegram("🔔 <b>TFEmby Web 通知测试成功</b>\n\nTelegram 求片通知已连接。", undefined);
}

async function tgBotCall(path: string, init?: RequestInit) {
  const response = await fetch(`${config.tgBotUrl}${path}`, {
    ...init,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(init?.headers || {}) },
    signal: AbortSignal.timeout(5000)
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error || `TG Bot HTTP ${response.status}`));
  return data;
}

export async function getTelegramIntegrationStatus() {
  let status: TgBotStatus | null = null;
  let reachable = false;
  try {
    const data = await tgBotCall("/api/status") as { status?: TgBotStatus };
    status = data.status || null;
    reachable = true;
  } catch {
    reachable = false;
  }
  return {
    directConfigured: telegramConfigured(),
    sidecarReachable: reachable,
    manageUrl: config.publicTgBotUrl,
    port: config.tgBotPort,
    status
  };
}

export async function controlTgBot(action: "start" | "stop" | "scan") {
  return tgBotCall(`/api/${action}`, { method: "POST", body: "{}" });
}
