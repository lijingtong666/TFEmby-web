import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSession } from "./auth.js";
import { config } from "./config.js";
import { externalServiceFetch } from "./proxy.js";
import { createMediaRequest } from "./requests.js";
import { fetchTmdbImage, fetchTmdbItem, fetchTmdbSeasons, searchTmdb } from "./tmdb.js";
import type { ChartItem, MediaRequest, RequestStatus } from "./types.js";

type EmbyItem = Record<string, any>;

type TelegramState = {
  seen: Record<string, { title: string; kind: string; type: string; eventAt: string; at: string }>;
  conversations: Record<string, { action: "search" | "request"; at: string }>;
  telegramUpdateOffset: number | null;
  lastScanAt: string | null;
  lastWebhookAt: string | null;
  lastError: string;
  lastSummary: string;
};

type TgBotStatus = {
  version: string;
  running: boolean;
  telegramRunning: boolean;
  lastTickAt: string | null;
  lastScanAt: string | null;
  lastWebhookAt: string | null;
  lastError: string;
  lastSummary: string;
  seenCount: number;
  logs: Array<{ at: string; message: string }>;
};

type Metadata = {
  tmdb: Record<string, any>;
  douban: Record<string, any>;
};

export type TgBotConfig = {
  telegramBotToken: string;
  telegramChatId: string;
  telegramMenuUserIds: string;
  tmdbApiKey: string;
  tmdbLanguage: string;
  embyUrl: string;
  embyApiKey: string;
  embyUserId: string;
  webhookSecret: string;
  doubanFallbackEnabled: boolean;
  enableCovers: boolean;
  overviewMaxLength: number;
  monitoredEvents: string;
  includeTypes: string[];
  pollIntervalSeconds: number;
  latestLimit: number;
  notifyFirstRun: boolean;
};

const botDataDir = path.resolve(config.dataDir, "telegram");
const botConfigPath = path.join(botDataDir, "config.json");
const botStatePath = path.join(botDataDir, "state.json");
const logs: TgBotStatus["logs"] = [];
let configQueue: Promise<unknown> = Promise.resolve();
let stateQueue: Promise<unknown> = Promise.resolve();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let polling = false;
let telegramRunning = false;
let lastTickAt: string | null = null;

const statusLabels: Record<RequestStatus, string> = {
  pending: "待处理",
  approved: "已接收",
  fulfilled: "已入库",
  rejected: "已拒绝"
};

const embyFields = [
  "DateCreated",
  "ProviderIds",
  "Overview",
  "Genres",
  "ProductionYear",
  "PremiereDate",
  "CommunityRating",
  "OfficialRating",
  "SeriesId",
  "SeriesName",
  "ParentIndexNumber",
  "IndexNumber",
  "ImageTags",
  "MediaSources",
  "MediaStreams",
  "ProductionLocations"
].join(",");

function nowIso() {
  return new Date().toISOString();
}

function formatDateTime(value: unknown) {
  const date = value ? new Date(String(value)) : new Date();
  if (Number.isNaN(date.getTime())) return String(value || "").slice(0, 16).replace("T", " ");
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date).replaceAll("/", "-");
}

function addLog(message: string) {
  logs.push({ at: formatDateTime(nowIso()), message });
  if (logs.length > 120) logs.splice(0, logs.length - 120);
  console.log(`[Telegram] ${message}`);
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function cleanUrl(value: unknown) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function defaultBotConfig(): TgBotConfig {
  return {
    telegramBotToken: config.telegramBotToken,
    telegramChatId: config.telegramChatId,
    telegramMenuUserIds: "",
    tmdbApiKey: config.tmdbApiKey,
    tmdbLanguage: "zh-CN",
    embyUrl: config.embyServerUrl,
    embyApiKey: "",
    embyUserId: "",
    webhookSecret: "",
    doubanFallbackEnabled: true,
    enableCovers: true,
    overviewMaxLength: 420,
    monitoredEvents: "library.new,item.added,item.created,itemadded",
    includeTypes: ["Movie", "Episode"],
    pollIntervalSeconds: 300,
    latestLimit: 20,
    notifyFirstRun: false
  };
}

function normalizeBotConfig(input: Partial<TgBotConfig>): TgBotConfig {
  const fallback = defaultBotConfig();
  return {
    telegramBotToken: String(input.telegramBotToken ?? fallback.telegramBotToken).trim(),
    telegramChatId: String(input.telegramChatId ?? fallback.telegramChatId).trim(),
    telegramMenuUserIds: String(input.telegramMenuUserIds ?? fallback.telegramMenuUserIds).trim(),
    tmdbApiKey: String(input.tmdbApiKey ?? fallback.tmdbApiKey).trim(),
    tmdbLanguage: String(input.tmdbLanguage ?? fallback.tmdbLanguage).trim() || "zh-CN",
    embyUrl: cleanUrl(input.embyUrl ?? fallback.embyUrl),
    embyApiKey: String(input.embyApiKey ?? fallback.embyApiKey).trim(),
    embyUserId: String(input.embyUserId ?? fallback.embyUserId).trim(),
    webhookSecret: String(input.webhookSecret ?? fallback.webhookSecret).trim(),
    doubanFallbackEnabled: input.doubanFallbackEnabled ?? fallback.doubanFallbackEnabled,
    enableCovers: input.enableCovers ?? fallback.enableCovers,
    overviewMaxLength: clamp(input.overviewMaxLength, 80, 2000, fallback.overviewMaxLength),
    monitoredEvents: String(input.monitoredEvents ?? fallback.monitoredEvents).trim(),
    includeTypes: Array.isArray(input.includeTypes) ? input.includeTypes.map(String).filter(Boolean) : fallback.includeTypes,
    pollIntervalSeconds: clamp(input.pollIntervalSeconds, 60, 86400, fallback.pollIntervalSeconds),
    latestLimit: clamp(input.latestLimit, 1, 100, fallback.latestLimit),
    notifyFirstRun: input.notifyFirstRun ?? fallback.notifyFirstRun
  };
}

function defaultState(): TelegramState {
  return {
    seen: {},
    conversations: {},
    telegramUpdateOffset: null,
    lastScanAt: null,
    lastWebhookAt: null,
    lastError: "",
    lastSummary: ""
  };
}

async function loadJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return { ...fallback, ...JSON.parse(await readFile(filePath, "utf8")) } as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") addLog(`配置读取失败：${(error as Error).message}`);
    return fallback;
  }
}

async function saveJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

async function getState() {
  return loadJson(botStatePath, defaultState());
}

function saveState(state: TelegramState) {
  const task = stateQueue.then(() => saveJson(botStatePath, state));
  stateQueue = task.catch(() => undefined);
  return task;
}

function parseChatIds(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function menuAllowed(settings: TgBotConfig, chatId: string, userId: string) {
  const adminChats = parseChatIds(settings.telegramChatId);
  const menuUsers = parseChatIds(settings.telegramMenuUserIds);
  return adminChats.includes(chatId) || menuUsers.includes(userId) || menuUsers.includes(chatId);
}

function botConfigured(settings: TgBotConfig) {
  return Boolean(settings.telegramBotToken && parseChatIds(settings.telegramChatId).length);
}

function requireValues(settings: TgBotConfig, keys: Array<keyof TgBotConfig>) {
  const missing = keys.filter((key) => !settings[key]);
  if (missing.length) throw new Error(`缺少配置：${missing.join(", ")}`);
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await externalServiceFetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok || data.ok === false) throw new Error(String(data.error || data.description || `HTTP ${response.status}`));
  return data;
}

async function telegramForm(settings: TgBotConfig, method: string, values: Record<string, string>) {
  const response = await externalServiceFetch(`${config.telegramApiBase}/bot${settings.telegramBotToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
  return result;
}

async function telegramMultipart(settings: TgBotConfig, chatId: string, image: Blob, caption: string) {
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("photo", image, "poster.jpg");
  form.set("caption", caption);
  form.set("parse_mode", "HTML");
  const response = await externalServiceFetch(`${config.telegramApiBase}/bot${settings.telegramBotToken}/sendPhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000)
  });
  const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
}

async function sendBotText(settings: TgBotConfig, text: string, chatId?: string, replyMarkup?: Record<string, unknown>) {
  requireValues(settings, ["telegramBotToken"]);
  const targets = chatId ? [chatId] : parseChatIds(settings.telegramChatId);
  if (!targets.length) throw new Error("缺少配置：telegramChatId");
  for (const target of targets) {
    await telegramForm(settings, "sendMessage", {
      chat_id: target,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: "false",
      ...(replyMarkup ? { reply_markup: JSON.stringify(replyMarkup) } : {})
    });
  }
  return targets.length;
}

async function answerCallback(settings: TgBotConfig, callbackQueryId: string, text = "", showAlert = false) {
  if (!callbackQueryId) return;
  await telegramForm(settings, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
    ...(showAlert ? { show_alert: "true" } : {})
  });
}

async function sendTelegram(message: string, photo?: string) {
  const settings = normalizeBotConfig({ telegramBotToken: config.telegramBotToken, telegramChatId: config.telegramChatId });
  if (!botConfigured(settings)) return { configured: false, sent: 0 };
  let sent = 0;
  for (const chatId of parseChatIds(settings.telegramChatId)) {
    if (photo?.startsWith("/api/tmdb/image")) {
      try {
        const url = new URL(photo, "http://localhost");
        const response = await fetchTmdbImage(url.searchParams.get("path") || "", url.searchParams.get("size") || "w500");
        await telegramMultipart(settings, chatId, await response.blob(), message);
        sent += 1;
        continue;
      } catch {
        // A text notification is still useful when the poster cannot be downloaded.
      }
    }
    if (photo?.startsWith("https://")) {
      try {
        await telegramForm(settings, "sendPhoto", { chat_id: chatId, photo, caption: message, parse_mode: "HTML" });
        sent += 1;
        continue;
      } catch {
        // Telegram may fail to download a remote poster; text is still delivered.
      }
    }
    await telegramForm(settings, "sendMessage", { chat_id: chatId, text: message, parse_mode: "HTML", disable_web_page_preview: "true" });
    sent += 1;
  }
  return { configured: true, sent };
}

function tmdbUrl(request: MediaRequest) {
  const base = `https://www.themoviedb.org/${request.mediaType}/${encodeURIComponent(request.tmdbId)}`;
  return request.mediaType === "tv" && request.seasonNumber ? `${base}/season/${request.seasonNumber}` : base;
}

export function telegramConfigured() {
  return Boolean(config.telegramBotToken && parseChatIds(config.telegramChatId).length);
}

export function notifyRequestCreated(request: MediaRequest) {
  return sendTelegram([
    "📨 <b>新的求片申请</b>",
    "",
    `<b>提交用户：</b>${escapeHtml(request.requestedBy.username)}`,
    `<b>影片名称：</b>${escapeHtml(request.title)}`,
    `<b>媒体类型：</b>${request.mediaType === "tv" ? "剧集" : "电影"}`,
    ...(request.seasonNumber ? [`<b>申请季度：</b>第 ${request.seasonNumber} 季`] : []),
    `<b>上映年份：</b>${request.year ? escapeHtml(request.year) : "未知"}`,
    `<b>TMDB ID：</b>${escapeHtml(request.tmdbId)}`,
    `<b>详情链接：</b><a href="${tmdbUrl(request)}">打开 TMDB</a>`
  ].join("\n"), request.poster);
}

export function notifyRequestStatus(request: MediaRequest, operator: string) {
  const icon = request.status === "fulfilled" ? "✅" : request.status === "rejected" ? "❌" : "🔔";
  return sendTelegram([
    `${icon} <b>求片状态更新</b>`,
    "",
    `<b>片名：</b>${escapeHtml(request.title)}`,
    ...(request.seasonNumber ? [`<b>申请季度：</b>第 ${request.seasonNumber} 季`] : []),
    `<b>状态：</b>${statusLabels[request.status]}`,
    `<b>申请人：</b>${escapeHtml(request.requestedBy.username)}`,
    `<b>操作人：</b>${escapeHtml(operator)}`,
    `<b>TMDB：</b><a href="${tmdbUrl(request)}">${escapeHtml(request.tmdbId)}</a>`
  ].join("\n"), request.poster);
}

export function sendTelegramTest() {
  return sendTelegram("🔔 <b>TFEmby Web 通知测试成功</b>\n\nTelegram 求片和入库通知已连接。", undefined);
}

export async function getTgBotConfig() {
  return normalizeBotConfig(await loadJson<Partial<TgBotConfig>>(botConfigPath, {}));
}

export function saveTgBotConfig(settings: TgBotConfig) {
  const task = configQueue.then(async () => {
    const normalized = normalizeBotConfig(settings);
    await saveJson(botConfigPath, normalized);
    addLog("通知配置已保存");
    return normalized;
  });
  configQueue = task.catch(() => undefined);
  return task;
}

function embyBase(settings: TgBotConfig) {
  const base = cleanUrl(settings.embyUrl);
  if (!base) throw new Error("缺少配置：embyUrl");
  return base.endsWith("/emby") ? base : `${base}/emby`;
}

async function embyGet(settings: TgBotConfig, endpoint: string, params: Record<string, string | number> = {}) {
  requireValues(settings, ["embyUrl", "embyApiKey"]);
  const url = new URL(`${embyBase(settings)}/${endpoint.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Accept: "application/json", "X-Emby-Token": settings.embyApiKey }, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(String(data.error || `Emby HTTP ${response.status}`));
  return data;
}

async function tmdbGet(settings: TgBotConfig, endpoint: string, params: Record<string, string> = {}) {
  const apiKey = settings.tmdbApiKey || config.tmdbApiKey;
  const bearer = config.tmdbBearerToken;
  if (!apiKey && !bearer) throw new Error("缺少配置：TMDB API Key 或 Bearer Token");
  const url = new URL(`https://api.themoviedb.org/3/${endpoint.replace(/^\/+/, "")}`);
  url.searchParams.set("language", settings.tmdbLanguage || "zh-CN");
  if (apiKey) url.searchParams.set("api_key", apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return fetchJson(url.toString(), { headers });
}

async function buildMetadata(settings: TgBotConfig, item: EmbyItem): Promise<Metadata> {
  let tmdb: Record<string, any> = {};
  let douban: Record<string, any> = {};
  const kind = item.Type === "Movie" ? "movie" : "tv";
  const providerId = item.ProviderIds?.Tmdb || item.ProviderIds?.TMDb;
  try {
    if (providerId) {
      tmdb = await tmdbGet(settings, `${kind}/${providerId}`, { append_to_response: "content_ratings,release_dates,alternative_titles" });
    } else {
      const query = item.SeriesName || item.Name;
      if (query) {
        const result = await tmdbGet(settings, `search/${kind}`, { query: String(query) });
        const match = result.results?.[0];
        if (match?.id) tmdb = await tmdbGet(settings, `${kind}/${match.id}`, { append_to_response: "content_ratings,release_dates,alternative_titles" });
      }
    }
  } catch (error) {
    addLog(`TMDB 补全失败：${item.Name || item.SeriesName || "未知项目"} / ${(error as Error).message}`);
  }

  if (settings.doubanFallbackEnabled && (!tmdb.poster_path || !tmdb.overview)) {
    try {
      const url = new URL("https://movie.douban.com/j/subject_suggest");
      url.searchParams.set("q", String(item.SeriesName || item.Name || ""));
      const response = await fetch(url, { headers: { Referer: "https://movie.douban.com/", "User-Agent": "Mozilla/5.0 (TFEmby Web)" }, signal: AbortSignal.timeout(12000) });
      const rows = await response.json().catch(() => []) as Array<Record<string, any>>;
      douban = rows[0] || {};
    } catch (error) {
      addLog(`豆瓣补全失败：${(error as Error).message}`);
    }
  }
  return { tmdb, douban };
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function episodeToken(item: EmbyItem) {
  const season = number(item.ParentIndexNumber);
  const episode = number(item.IndexNumber);
  return season && episode ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}` : "";
}

function episodeRange(episodes: EmbyItem[]) {
  const sorted = episodes.filter((item) => item.Type === "Episode" && number(item.ParentIndexNumber) && number(item.IndexNumber))
    .sort((a, b) => number(a.ParentIndexNumber) - number(b.ParentIndexNumber) || number(a.IndexNumber) - number(b.IndexNumber));
  if (!sorted.length) return episodes.length ? `(共 ${episodes.length} 集)` : "";
  const groups = new Map<number, number[]>();
  for (const item of sorted) {
    const season = number(item.ParentIndexNumber);
    groups.set(season, [...(groups.get(season) || []), number(item.IndexNumber)]);
  }
  const ranges = [...groups.entries()].map(([season, indexes]) => {
    const values = [...new Set(indexes)].sort((a, b) => a - b);
    const first = `S${String(season).padStart(2, "0")}E${String(values[0]).padStart(2, "0")}`;
    return values.length === 1 ? first : `${first}-E${String(values.at(-1)).padStart(2, "0")}`;
  });
  return `${ranges.join(", ")} (共 ${sorted.length} 集)`;
}

function displayTitle(item: EmbyItem) {
  if (item._RecentEpisodes?.length) return `${item.Name || item.SeriesName || "未命名"} ${episodeRange(item._RecentEpisodes)}`;
  if (item.Type === "Episode") return `${item.SeriesName || item.Name || "未命名"} ${episodeToken(item)}`.trim();
  return item.Name || "未命名";
}

function mediaKind(item: EmbyItem) {
  return item.Type === "Movie" ? "电影" : "剧集";
}

function mediaStreams(item: EmbyItem) {
  const streams = [...(item.MediaStreams || [])];
  for (const source of item.MediaSources || []) streams.push(...(source.MediaStreams || []));
  return streams;
}

function qualityLabel(item: EmbyItem) {
  const stream = mediaStreams(item).find((value) => String(value.Type).toLowerCase() === "video") || {};
  const source = item.MediaSources?.[0] || {};
  const height = number(stream.Height || source.Height);
  const width = number(stream.Width || source.Width);
  const resolution = height >= 2160 || width >= 3800 ? "4K" : height >= 1440 ? "2K" : height >= 1080 ? "1080P" : height >= 720 ? "720P" : "N/A";
  const description = [stream.VideoRangeType, stream.VideoRange, stream.Profile, stream.DisplayTitle, source.Name].filter(Boolean).join(" ").toLowerCase();
  const tags = [resolution];
  if (/dolby vision|dovi/.test(description)) tags.push("Dolby Vision");
  else if (/hdr10\+/.test(description)) tags.push("HDR10+");
  else if (/hdr/.test(description)) tags.push("HDR");
  return `[${tags.join(" · ")}]`;
}

function itemSize(item: EmbyItem) {
  const sources = item.MediaSources || [];
  return sources.reduce((sum: number, source: EmbyItem) => sum + number(source.Size), 0) || number(item.Size);
}

function totalSize(item: EmbyItem) {
  return item._RecentEpisodes?.length ? item._RecentEpisodes.reduce((sum: number, episode: EmbyItem) => sum + itemSize(episode), 0) : itemSize(item);
}

function sizeLabel(bytes: number) {
  if (!bytes) return "N/A";
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index ? `${value.toFixed(2)}${units[index]}` : `${Math.round(value)}B`;
}

const countryNames: Record<string, string> = {
  CN: "中国大陆", HK: "中国香港", TW: "中国台湾", US: "美国", GB: "英国", JP: "日本", KR: "韩国",
  TH: "泰国", IN: "印度", FR: "法国", DE: "德国", CA: "加拿大", AU: "澳大利亚"
};

function regionLabel(item: EmbyItem, metadata: Metadata) {
  const tmdb = metadata.tmdb;
  const countries = tmdb.production_countries?.map((entry: EmbyItem) => entry.iso_3166_1 || entry.name) || tmdb.origin_country || item.ProductionLocations || [];
  return countries.slice(0, 3).map((country: string) => countryNames[country] || country).filter(Boolean).join(" / ") || "N/A";
}

function genreLabel(item: EmbyItem, metadata: Metadata) {
  const genres = metadata.tmdb.genres?.map((entry: EmbyItem) => entry.name) || item.Genres || [];
  return genres.slice(0, 4).filter(Boolean).join(" / ") || "N/A";
}

function certification(item: EmbyItem, metadata: Metadata) {
  if (item.OfficialRating) return String(item.OfficialRating);
  const tmdb = metadata.tmdb;
  const ratings = tmdb.content_ratings?.results || [];
  const tvRating = ratings.find((entry: EmbyItem) => entry.iso_3166_1 === "CN") || ratings.find((entry: EmbyItem) => entry.iso_3166_1 === "US") || ratings[0];
  if (tvRating?.rating) return tvRating.rating;
  const releases = tmdb.release_dates?.results || [];
  const movieRelease = releases.find((entry: EmbyItem) => entry.iso_3166_1 === "CN") || releases.find((entry: EmbyItem) => entry.iso_3166_1 === "US") || releases[0];
  return movieRelease?.release_dates?.find((entry: EmbyItem) => entry.certification)?.certification || "";
}

function alternateTitle(item: EmbyItem, metadata: Metadata) {
  const candidates = metadata.tmdb.alternative_titles?.results || metadata.tmdb.alternative_titles?.titles || [];
  return candidates.find((entry: EmbyItem) => entry.iso_3166_1 === "CN")?.title || candidates.find((entry: EmbyItem) => entry.title)?.title || item.OriginalTitle || metadata.douban.title || "";
}

function tmdbId(item: EmbyItem, metadata: Metadata) {
  return String(metadata.tmdb.id || item.ProviderIds?.Tmdb || item.ProviderIds?.TMDb || "N/A");
}

function tmdbPage(item: EmbyItem, metadata: Metadata) {
  const id = tmdbId(item, metadata);
  return id === "N/A" ? "" : `https://www.themoviedb.org/${item.Type === "Movie" ? "movie" : "tv"}/${encodeURIComponent(id)}`;
}

function eventTime(item: EmbyItem, payload?: EmbyItem) {
  return payload?.Date || payload?.Timestamp || payload?.TimeStamp || payload?.ItemDateAdded || item.DateCreated || nowIso();
}

function formatEventDateTime(value: unknown) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : formatDateTime(value);
}

export function formatLibraryMessage(settings: TgBotConfig, item: EmbyItem, metadata: Metadata, payload?: EmbyItem) {
  const tmdb = metadata.tmdb;
  const overview = String(tmdb.overview || item.Overview || metadata.douban.sub_title || "").trim();
  const maxOverview = clamp(settings.overviewMaxLength, 80, 520, 360);
  const trimmedOverview = overview.length > maxOverview ? `${overview.slice(0, maxOverview - 3).trim()}...` : overview;
  const rating = number(tmdb.vote_average || item.CommunityRating);
  const year = item.ProductionYear || String(tmdb.release_date || tmdb.first_air_date || item.PremiereDate || metadata.douban.year || "").slice(0, 4) || "N/A";
  const sample = item._RecentEpisodes?.[0] || item;
  const icon = item.Type === "Movie" ? "🎬" : "📺";
  const lines = [
    `${icon} <b>新入库 ${mediaKind(item)}</b> <b>${escapeHtml(displayTitle(item))}</b>`,
    "",
    `TMDB ID: ${escapeHtml(tmdbId(item, metadata))}`,
    `评分: ${rating ? rating.toFixed(1) : "N/A"}`,
    `题材: ${escapeHtml(genreLabel(item, metadata))}`,
    `地区: ${escapeHtml(regionLabel(item, metadata))}`,
    `质量: ${escapeHtml(qualityLabel(sample))}`,
    `总大小: ${escapeHtml(sizeLabel(totalSize(item)))}`,
    `年份: ${escapeHtml(year)}`,
    `时间: ${escapeHtml(formatEventDateTime(eventTime(item, payload)))}`
  ];
  if (trimmedOverview) lines.push("", "📝 <b>剧情简介：</b>", escapeHtml(trimmedOverview));
  const intro = [certification(item, metadata) ? `分级：${certification(item, metadata)}` : "", alternateTitle(item, metadata) ? `别名：${alternateTitle(item, metadata)}` : ""].filter(Boolean);
  if (intro.length) lines.push("", `介绍：${escapeHtml(intro.join("；"))}`);
  const link = tmdbPage(item, metadata);
  if (link) lines.push("", link);
  return lines.join("\n");
}

function posterSource(settings: TgBotConfig, item: EmbyItem, metadata: Metadata) {
  if (!settings.enableCovers) return { url: "", source: "none" as const };
  if (metadata.tmdb.poster_path) return { url: `https://image.tmdb.org/t/p/w780${metadata.tmdb.poster_path}`, source: "tmdb" as const };
  if (metadata.douban.img) return { url: String(metadata.douban.img), source: "remote" as const };
  if (item.ImageTags?.Primary && item.Id) return { url: `${embyBase(settings)}/Items/${encodeURIComponent(item.Id)}/Images/Primary?maxHeight=1200&quality=90`, source: "emby" as const };
  return { url: "", source: "none" as const };
}

async function sendLibraryNotification(settings: TgBotConfig, item: EmbyItem, metadata: Metadata, payload?: EmbyItem) {
  requireValues(settings, ["telegramBotToken", "telegramChatId"]);
  const message = formatLibraryMessage(settings, item, metadata, payload);
  const poster = posterSource(settings, item, metadata);
  for (const chatId of parseChatIds(settings.telegramChatId)) {
    if (poster.url) {
      try {
        if (poster.source === "emby") {
          const response = await fetch(poster.url, { headers: { "X-Emby-Token": settings.embyApiKey }, signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw new Error(`Emby 海报 HTTP ${response.status}`);
          await telegramMultipart(settings, chatId, await response.blob(), message);
        } else if (poster.source === "tmdb") {
          const response = await externalServiceFetch(poster.url, { signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw new Error(`TMDB 海报 HTTP ${response.status}`);
          await telegramMultipart(settings, chatId, await response.blob(), message);
        } else {
          await telegramForm(settings, "sendPhoto", { chat_id: chatId, photo: poster.url, caption: message, parse_mode: "HTML" });
        }
        continue;
      } catch (error) {
        addLog(`海报发送失败，改发文字：${(error as Error).message}`);
      }
    }
    await sendBotText(settings, message, chatId);
  }
}

async function getLatestItems(settings: TgBotConfig, limit = settings.latestLimit) {
  const params: Record<string, string | number> = { IncludeItemTypes: settings.includeTypes.join(","), Fields: embyFields, EnableImages: "true", Limit: limit };
  if (settings.embyUserId) return embyGet(settings, `Users/${encodeURIComponent(settings.embyUserId)}/Items/Latest`, params);
  return embyGet(settings, "Items/Latest", params);
}

async function getEmbyItem(settings: TgBotConfig, id: string) {
  return embyGet(settings, `Items/${encodeURIComponent(id)}`, { Fields: embyFields });
}

async function getSeriesEpisodes(settings: TgBotConfig, seriesId: string) {
  const data = await embyGet(settings, "Items", { Recursive: "true", IncludeItemTypes: "Episode", SeriesId: seriesId, Fields: embyFields, EnableImages: "true", SortBy: "DateCreated", SortOrder: "Descending", Limit: 100 });
  return Array.isArray(data) ? data : data.Items || [];
}

function dateKey(value: unknown) {
  return String(value || "").slice(0, 10);
}

async function enrichEpisodeBatch(settings: TgBotConfig, item: EmbyItem, payload?: EmbyItem) {
  const seriesId = String(item.Type === "Series" ? item.Id : item.SeriesId || "");
  if (!seriesId || !["Series", "Episode"].includes(item.Type)) return item;
  try {
    const episodes = await getSeriesEpisodes(settings, seriesId);
    const targetDate = dateKey(payload?.Date || payload?.Timestamp || item.DateCreated) || dateKey(episodes[0]?.DateCreated);
    const recent = episodes.filter((episode: EmbyItem) => !targetDate || dateKey(episode.DateCreated) === targetDate).slice(0, 50);
    if (!recent.length) return item;
    let series = item;
    if (item.Type === "Episode") {
      try { series = await getEmbyItem(settings, seriesId); } catch { series = { ...item, Id: seriesId, Name: item.SeriesName, Type: "Series" }; }
    }
    return { ...series, Type: "Series", _RecentEpisodes: recent };
  } catch (error) {
    addLog(`读取同批剧集失败：${(error as Error).message}`);
    return item;
  }
}

function monitoredEvent(settings: TgBotConfig, event: string) {
  if (!event) return true;
  const normalized = event.toLowerCase();
  const configured = settings.monitoredEvents.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return configured.includes(normalized) || ["library.new", "item.add", "itemadded", "item.created", "media.add", "created"].some((marker) => normalized.includes(marker));
}

function webhookValue(payload: EmbyItem, names: string[]): any {
  for (const name of names) {
    if (payload[name] !== undefined && payload[name] !== "") return payload[name];
    if (payload.Item?.[name] !== undefined && payload.Item?.[name] !== "") return payload.Item[name];
  }
  return "";
}

function normalizeWebhookItem(payload: EmbyItem) {
  const item = { ...(payload.Item && typeof payload.Item === "object" ? payload.Item : {}) };
  const values: EmbyItem = {
    Id: webhookValue(payload, ["ItemId", "ItemID", "Id", "itemId"]),
    Name: webhookValue(payload, ["ItemName", "Name", "Title"]),
    Type: webhookValue(payload, ["ItemType", "Type"]),
    SeriesName: webhookValue(payload, ["SeriesName"]),
    DateCreated: webhookValue(payload, ["ItemDateAdded", "DateCreated", "DateAdded"])
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") item[key] = value;
  }
  return item;
}

function webhookEvent(payload: EmbyItem) {
  return String(webhookValue(payload, ["Event", "NotificationType", "event_type", "EventName"]));
}

function isWebhookTest(payload: EmbyItem) {
  if (!payload || !Object.keys(payload).length) return true;
  const event = webhookEvent(payload).toLowerCase();
  return ["test", "notification.test", "notifications.test", "webhook.test"].includes(event) || (!webhookValue(payload, ["ItemId", "Id", "ItemName", "Name"]) && JSON.stringify(payload).toLowerCase().includes("test"));
}

export async function handleEmbyWebhook(payload: EmbyItem, headers: Record<string, string | string[] | undefined>, token = "") {
  const settings = await getTgBotConfig();
  const receivedSecret = token || String(headers["x-webhook-token"] || headers["x-emby-webhook-secret"] || "");
  if (settings.webhookSecret && receivedSecret !== settings.webhookSecret) {
    const error = new Error("Webhook 密钥不正确");
    (error as Error & { status?: number }).status = 403;
    throw error;
  }
  const state = await getState();
  state.lastWebhookAt = nowIso();
  if (isWebhookTest(payload)) {
    let sent = 0;
    try {
      sent = await sendBotText(settings, "这是一条 TFEmby Web 测试信息");
      state.lastError = "";
      state.lastSummary = `Emby Webhook 测试成功，Telegram 已发送 ${sent} 个会话`;
    } catch (error) {
      state.lastError = (error as Error).message;
      state.lastSummary = "Emby Webhook 测试已收到，但 Telegram 测试发送失败";
    }
    await saveState(state);
    return { ignored: false, test: true, sent, telegramError: state.lastError || undefined };
  }
  const event = webhookEvent(payload);
  if (!monitoredEvent(settings, event)) return { ignored: true, reason: `非入库事件：${event}` };
  let item = normalizeWebhookItem(payload);
  if (item.Id) {
    try { item = { ...(await getEmbyItem(settings, String(item.Id))), ...item }; } catch (error) { addLog(`读取 Emby 项目失败：${(error as Error).message}`); }
  }
  item = await enrichEpisodeBatch(settings, item, payload);
  if (!item.Name && !item.SeriesName) throw new Error("Webhook 内容里没有项目名称或 ItemId");
  const allowed = new Set(settings.includeTypes);
  if (item.Type === "Movie" && !allowed.has("Movie")) return { ignored: true, reason: "未启用电影通知" };
  if (item.Type !== "Movie" && !allowed.has("Episode") && !allowed.has("Series")) return { ignored: true, reason: "未启用剧集通知" };
  const range = item._RecentEpisodes?.length ? episodeRange(item._RecentEpisodes) : episodeToken(item);
  const dedupeKey = `${item.Type}:${item.Id || item.SeriesId || item.Name}:${range}:${dateKey(eventTime(item, payload))}`;
  if (state.seen[dedupeKey]) return { ignored: true, reason: "重复项目" };
  const metadata = await buildMetadata(settings, item);
  await sendLibraryNotification(settings, item, metadata, payload);
  state.seen[dedupeKey] = { title: displayTitle(item), kind: mediaKind(item), type: String(item.Type), eventAt: formatEventDateTime(eventTime(item, payload)), at: nowIso() };
  state.lastError = "";
  state.lastSummary = `Webhook 推送完成：${displayTitle(item)}`;
  await saveState(state);
  addLog(state.lastSummary);
  return { ignored: false, title: displayTitle(item) };
}

async function scanOnce(sendNotifications = true) {
  const settings = await getTgBotConfig();
  const state = await getState();
  const latest = await getLatestItems(settings);
  const items: EmbyItem[] = Array.isArray(latest) ? latest : latest.Items || [];
  const firstScan = !Object.keys(state.seen).length;
  const shouldNotify = sendNotifications && (settings.notifyFirstRun || !firstScan);
  let sent = 0;
  let recorded = 0;
  for (const rawItem of [...items].reverse()) {
    const item = await enrichEpisodeBatch(settings, rawItem);
    const key = `poll:${item.Id || item.Name}:${item._RecentEpisodes?.length ? episodeRange(item._RecentEpisodes) : episodeToken(item)}`;
    if (state.seen[key]) continue;
    if (shouldNotify) {
      await sendLibraryNotification(settings, item, await buildMetadata(settings, item));
      sent += 1;
    }
    state.seen[key] = { title: displayTitle(item), kind: mediaKind(item), type: String(item.Type), eventAt: formatEventDateTime(item.DateCreated), at: nowIso() };
    recorded += 1;
  }
  state.lastScanAt = nowIso();
  state.lastError = "";
  state.lastSummary = `扫描完成：最新 ${items.length} 个，新增记录 ${recorded} 个，推送 ${sent} 条`;
  await saveState(state);
  addLog(state.lastSummary);
  return { summary: state.lastSummary, sent, recorded, total: items.length, errors: [] };
}

function schedulePoll(delay = 0) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!polling) return;
    lastTickAt = nowIso();
    try {
      await scanOnce(true);
    } catch (error) {
      const state = await getState();
      state.lastError = (error as Error).message;
      await saveState(state);
      addLog(`扫描失败：${state.lastError}`);
    }
    if (polling) schedulePoll((await getTgBotConfig()).pollIntervalSeconds * 1000);
  }, delay);
}

function itemRows(data: any): EmbyItem[] {
  return Array.isArray(data) ? data : Array.isArray(data?.Items) ? data.Items : [];
}

function lookupTitle(value: unknown) {
  return String(value || "").toLowerCase().replace(/[：:·'".,，。！？!?()\[\]【】\s-]/g, "").trim();
}

function tmdbProviderId(item: EmbyItem) {
  return String(item.ProviderIds?.Tmdb || item.ProviderIds?.TMDb || item.ProviderIds?.tmdb || "");
}

async function searchLibraryForBot(settings: TgBotConfig, query: string) {
  const common = { Recursive: "true", IncludeItemTypes: "Movie,Series", Fields: embyFields, EnableImages: "true", Limit: 20 };
  if (/^\d+$/.test(query)) {
    return itemRows(await embyGet(settings, "Items", { ...common, AnyProviderIdEquals: `tmdb.${query}` }));
  }
  return itemRows(await embyGet(settings, "Items", { ...common, SearchTerm: query }));
}

async function findLibraryItemForBot(settings: TgBotConfig, item: ChartItem) {
  const tmdbId = item.externalIds.tmdb || "";
  const includeType = item.mediaType === "movie" ? "Movie" : "Series";
  const common = { Recursive: "true", IncludeItemTypes: includeType, Fields: embyFields, EnableImages: "true", Limit: 25 };
  const exact = tmdbId
    ? itemRows(await embyGet(settings, "Items", { ...common, AnyProviderIdEquals: `tmdb.${tmdbId}` }).catch(() => ({ Items: [] })))
    : [];
  const named = itemRows(await embyGet(settings, "Items", { ...common, SearchTerm: item.title }).catch(() => ({ Items: [] })));
  const candidates = [...exact, ...named.filter((candidate) => !exact.some((existing) => existing.Id === candidate.Id))];
  return candidates.find((candidate) => {
    const sameTmdb = tmdbId && tmdbProviderId(candidate) === tmdbId;
    const sameTitle = [candidate.Name, candidate.OriginalTitle].some((title) => lookupTitle(title) === lookupTitle(item.title));
    const sameYear = !item.year || !candidate.ProductionYear || Number(candidate.ProductionYear) === item.year;
    return Boolean(sameTmdb || (sameTitle && sameYear));
  }) || null;
}

async function librarySeasonNumbersForBot(settings: TgBotConfig, item: ChartItem) {
  const series = await findLibraryItemForBot(settings, item);
  if (!series?.Id) return new Set<number>();
  const seasonData = await embyGet(settings, "Items", { ParentId: series.Id, IncludeItemTypes: "Season", Fields: "IndexNumber", Limit: 100 });
  const seasons = new Set(itemRows(seasonData).map((season) => Number(season.IndexNumber)).filter((value) => Number.isInteger(value) && value > 0));
  if (seasons.size) return seasons;
  const episodeData = await embyGet(settings, "Items", { ParentId: series.Id, Recursive: "true", IncludeItemTypes: "Episode", Fields: "ParentIndexNumber", Limit: 10000 });
  return new Set(itemRows(episodeData).map((episode) => Number(episode.ParentIndexNumber)).filter((value) => Number.isInteger(value) && value > 0));
}

function episodeRangeChinese(episodes: EmbyItem[]) {
  const seasons = new Map<number, number[]>();
  for (const episode of episodes) {
    const season = number(episode.ParentIndexNumber);
    const index = number(episode.IndexNumber);
    if (season && index) seasons.set(season, [...(seasons.get(season) || []), index]);
  }
  if (!seasons.size) return `本次入库 ${episodes.length} 集`;
  return [...seasons.entries()].sort(([left], [right]) => left - right).map(([season, indexes]) => {
    const values = [...new Set(indexes)].sort((left, right) => left - right);
    const ranges: string[] = [];
    let start = values[0];
    let end = values[0];
    for (const current of values.slice(1)) {
      if (current === end + 1) {
        end = current;
        continue;
      }
      ranges.push(start === end ? `第${start}集` : `第${start}集-第${end}集`);
      start = current;
      end = current;
    }
    ranges.push(start === end ? `第${start}集` : `第${start}集-第${end}集`);
    return `第${season}季 ${ranges.join("、")}`;
  }).join(" · ");
}

async function recentLibraryMessage(settings: TgBotConfig) {
  const latest = itemRows(await getLatestItems(settings, 80));
  const episodeSeriesIds = new Set(latest.filter((item) => item.Type === "Episode" && item.SeriesId).map((item) => String(item.SeriesId)));
  const groups = new Map<string, EmbyItem[]>();
  const ordered: Array<{ type: "item"; item: EmbyItem } | { type: "episodes"; key: string; first: EmbyItem }> = [];
  for (const item of latest) {
    if (item.Type === "Series" && episodeSeriesIds.has(String(item.Id))) continue;
    if (item.Type !== "Episode") {
      ordered.push({ type: "item", item });
      continue;
    }
    const key = `${item.SeriesId || item.SeriesName || item.Id}:${dateKey(item.DateCreated)}`;
    if (!groups.has(key)) ordered.push({ type: "episodes", key, first: item });
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  const rows = ordered.slice(0, 20);
  if (!rows.length) return "📚 <b>最近入库 20 条</b>\n\n暂无入库记录。";
  return ["📚 <b>最近入库 20 条</b>", "", ...rows.flatMap((row, index) => {
    if (row.type === "episodes") {
      const episodes = groups.get(row.key) || [row.first];
      return [`${index + 1}. 📺 <b>${escapeHtml(row.first.SeriesName || row.first.Name || "未命名剧集")}</b>`, `   ${escapeHtml(episodeRangeChinese(episodes))} | ${escapeHtml(formatEventDateTime(row.first.DateCreated))}`];
    }
    return [`${index + 1}. ${row.item.Type === "Movie" ? "🎬" : "📺"} <b>${escapeHtml(row.item.Name || "未命名")}</b>`, `   ${escapeHtml(mediaKind(row.item))} | ${escapeHtml(formatEventDateTime(row.item.DateCreated))}`];
  })].join("\n");
}

function menuText() {
  return [
    "🤖 <b>TFEmby Web 机器人</b>",
    "",
    "/recent - 查看最近入库 20 条",
    "/search - 搜索 Emby 片库",
    "/request - 按片名或 TMDB ID 求片",
    "/cancel - 取消当前操作",
    "/help - 查看菜单"
  ].join("\n");
}

function menuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📚 最近入库 20 条", callback_data: "menu:recent" }],
      [{ text: "🔎 搜索片库", callback_data: "menu:search" }, { text: "➕ 用户求片", callback_data: "menu:request" }]
    ]
  };
}

function telegramUserName(user: Record<string, any>) {
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].map((value) => String(value || "").trim()).filter(Boolean).join(" ") || `Telegram ${user.id || "用户"}`;
}

function telegramSession(chatId: string, user: Record<string, any>): AppSession {
  return {
    token: "telegram",
    userId: `telegram:${user.id || chatId}`,
    username: telegramUserName(user),
    role: "user"
  };
}

function conversationKey(chatId: string, user: Record<string, any>) {
  return `${chatId}:${user.id || chatId}`;
}

async function tmdbRequestCandidates(query: string) {
  if (!/^\d+$/.test(query)) return (await searchTmdb(query)).slice(0, 8);
  const results = await Promise.allSettled([fetchTmdbItem(query, "movie"), fetchTmdbItem(query, "tv")]);
  const candidates = results.filter((result): result is PromiseFulfilledResult<ChartItem> => result.status === "fulfilled").map((result) => result.value);
  if (!candidates.length) {
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected" && Number(result.reason?.status) !== 404);
    if (failure) throw failure.reason;
  }
  return candidates;
}

async function sendRequestCandidates(settings: TgBotConfig, chatId: string, query: string) {
  const candidates = (await tmdbRequestCandidates(query)).filter((item) => item.externalIds.tmdb);
  if (!candidates.length) {
    await sendBotText(settings, `未在 TMDB 找到“${escapeHtml(query)}”。`, chatId);
    return;
  }
  const keyboard = candidates.map((item) => [{
    text: `${item.mediaType === "tv" ? "📺" : "🎬"} ${item.title.slice(0, 32)}${item.year ? ` (${item.year})` : ""}`,
    callback_data: `req:item:${item.mediaType}:${item.externalIds.tmdb}`
  }]);
  await sendBotText(settings, "请选择要申请的影片：", chatId, { inline_keyboard: keyboard });
}

async function sendLibrarySearch(settings: TgBotConfig, chatId: string, query: string) {
  const items = (await searchLibraryForBot(settings, query)).slice(0, 10);
  if (!items.length) {
    await sendBotText(settings, `❌ <b>库中未找到</b>\n\n${escapeHtml(query)}`, chatId);
    return;
  }
  await sendBotText(settings, [
    `✅ <b>库中找到 ${items.length} 条</b>`,
    "",
    ...items.flatMap((item, index) => [
      `${index + 1}. ${item.Type === "Movie" ? "🎬" : "📺"} <b>${escapeHtml(item.Name || "未命名")}</b>${item.ProductionYear ? ` (${escapeHtml(item.ProductionYear)})` : ""}`,
      `   ${item.Type === "Movie" ? "电影" : "剧集"}${tmdbProviderId(item) ? ` | TMDB ${escapeHtml(tmdbProviderId(item))}` : ""}`
    ])
  ].join("\n"), chatId);
}

async function submitTelegramRequest(settings: TgBotConfig, chatId: string, user: Record<string, any>, item: ChartItem, seasonNumber?: number) {
  if (item.mediaType === "movie") {
    const existing = await findLibraryItemForBot(settings, item);
    if (existing) {
      await sendBotText(settings, `✅ 《${escapeHtml(item.title)}》已在媒体库中。`, chatId);
      return;
    }
  }
  let season: { seasonNumber: number; seasonName: string } | undefined;
  if (item.mediaType === "tv") {
    if (!seasonNumber) throw new Error("请选择要申请的季度");
    const details = await fetchTmdbSeasons(item.externalIds.tmdb || "");
    const selected = details.seasons.find((candidate) => candidate.seasonNumber === seasonNumber);
    if (!selected) throw new Error("TMDB 中未找到该季度");
    const existingSeasons = await librarySeasonNumbersForBot(settings, details.item);
    if (existingSeasons.has(seasonNumber)) {
      await sendBotText(settings, `✅ 《${escapeHtml(item.title)}》第 ${seasonNumber} 季已在媒体库中。`, chatId);
      return;
    }
    item = details.item;
    season = { seasonNumber, seasonName: selected.name };
  }
  const created = await createMediaRequest(telegramSession(chatId, user), item, season);
  await notifyRequestCreated(created).catch((error: Error) => addLog(`Telegram 求片通知失败：${error.message}`));
  await sendBotText(settings, `📨 已提交《${escapeHtml(item.title)}》${seasonNumber ? `第 ${seasonNumber} 季` : ""}。\nTMDB ID：${escapeHtml(item.externalIds.tmdb)}`, chatId);
}

async function showTvSeasons(settings: TgBotConfig, chatId: string, tmdbId: string) {
  const details = await fetchTmdbSeasons(tmdbId);
  const existing = await librarySeasonNumbersForBot(settings, details.item);
  const keyboard = details.seasons.map((season) => [{
    text: existing.has(season.seasonNumber) ? `✅ 第${season.seasonNumber}季 · 库中存在` : `➕ 第${season.seasonNumber}季 · 申请`,
    callback_data: existing.has(season.seasonNumber) ? `req:exists:${tmdbId}:${season.seasonNumber}` : `req:season:${tmdbId}:${season.seasonNumber}`
  }]);
  if (!keyboard.length) {
    await sendBotText(settings, `《${escapeHtml(details.item.title)}》暂无可选择的季度。`, chatId);
    return;
  }
  await sendBotText(settings, `📺 <b>${escapeHtml(details.item.title)}</b>\n请选择季度：`, chatId, { inline_keyboard: keyboard });
}

async function handleTelegramMessage(settings: TgBotConfig, state: TelegramState, message: Record<string, any>) {
  const chatId = String(message.chat?.id || "");
  const user = message.from || {};
  const key = conversationKey(chatId, user);
  const text = String(message.text || "").trim();
  if (!text) return;
  const firstToken = text.split(/\s+/)[0];
  const command = firstToken.startsWith("/") ? firstToken.split("@")[0].toLowerCase() : "";
  const argument = command ? text.slice(firstToken.length).trim() : "";

  if (["/start", "/help"].includes(command)) {
    delete state.conversations[key];
    await sendBotText(settings, menuText(), chatId, menuKeyboard());
    return;
  }
  if (["/recent", "/latest"].includes(command)) {
    delete state.conversations[key];
    await sendBotText(settings, await recentLibraryMessage(settings), chatId);
    return;
  }
  if (command === "/search") {
    delete state.conversations[key];
    if (argument) await sendLibrarySearch(settings, chatId, argument);
    else {
      state.conversations[key] = { action: "search", at: nowIso() };
      await sendBotText(settings, "请输入要查询的影片名称或 TMDB ID：", chatId);
    }
    return;
  }
  if (["/request", "/wish"].includes(command)) {
    delete state.conversations[key];
    if (argument) await sendRequestCandidates(settings, chatId, argument);
    else {
      state.conversations[key] = { action: "request", at: nowIso() };
      await sendBotText(settings, "请输入影片名称或 TMDB ID：", chatId);
    }
    return;
  }
  if (command === "/cancel") {
    delete state.conversations[key];
    await sendBotText(settings, "已取消当前操作。", chatId);
    return;
  }
  if (command) {
    delete state.conversations[key];
    await sendBotText(settings, menuText(), chatId, menuKeyboard());
    return;
  }

  const conversation = state.conversations[key];
  if (!conversation) return;
  delete state.conversations[key];
  if (conversation.action === "search") await sendLibrarySearch(settings, chatId, text);
  else await sendRequestCandidates(settings, chatId, text);
}

async function handleTelegramCallback(settings: TgBotConfig, state: TelegramState, callback: Record<string, any>) {
  const callbackId = String(callback.id || "");
  const chatId = String(callback.message?.chat?.id || "");
  const user = callback.from || {};
  const data = String(callback.data || "");
  const key = conversationKey(chatId, user);

  if (data === "menu:recent") {
    await answerCallback(settings, callbackId, "正在读取最近入库");
    await sendBotText(settings, await recentLibraryMessage(settings), chatId);
    return;
  }
  if (data === "menu:search" || data === "menu:request") {
    await answerCallback(settings, callbackId);
    const action = data === "menu:search" ? "search" : "request";
    state.conversations[key] = { action, at: nowIso() };
    await sendBotText(settings, action === "search" ? "请输入要查询的影片名称或 TMDB ID：" : "请输入影片名称或 TMDB ID：", chatId);
    return;
  }

  const parts = data.split(":");
  if (parts[0] !== "req") return;
  if (parts[1] === "exists") {
    await answerCallback(settings, callbackId, `第 ${parts[3]} 季已在库中`, true);
    return;
  }
  if (parts[1] === "item") {
    const mediaType = parts[2] === "tv" ? "tv" : "movie";
    const tmdbId = parts[3];
    await answerCallback(settings, callbackId, mediaType === "tv" ? "正在读取季度" : "正在提交申请");
    if (mediaType === "tv") await showTvSeasons(settings, chatId, tmdbId);
    else await submitTelegramRequest(settings, chatId, user, await fetchTmdbItem(tmdbId, "movie"));
    return;
  }
  if (parts[1] === "season") {
    const tmdbId = parts[2];
    const seasonNumber = Number(parts[3]);
    await answerCallback(settings, callbackId, "正在提交申请");
    const details = await fetchTmdbSeasons(tmdbId);
    await submitTelegramRequest(settings, chatId, user, details.item, seasonNumber);
  }
}

async function telegramMenuLoop() {
  if (telegramRunning) return;
  telegramRunning = true;
  addLog("TFEmby Telegram 菜单监听已启动");
  let lastToken = "";
  while (telegramRunning) {
    const settings = await getTgBotConfig();
    if (!settings.telegramBotToken) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    try {
      if (lastToken !== settings.telegramBotToken) {
        await fetchJson(`${config.telegramApiBase}/bot${settings.telegramBotToken}/setMyCommands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commands: [
            { command: "start", description: "开始使用机器人" },
            { command: "recent", description: "查看最近入库 20 条" },
            { command: "search", description: "搜索库中影片是否存在" },
            { command: "request", description: "输入片名或 TMDB ID 求片" },
            { command: "cancel", description: "取消当前操作" },
            { command: "help", description: "查看使用说明" }
          ] })
        });
        lastToken = settings.telegramBotToken;
      }
      const state = await getState();
      const updates = await fetchJson(`${config.telegramApiBase}/bot${settings.telegramBotToken}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeout: 20, offset: state.telegramUpdateOffset || undefined, allowed_updates: ["message", "callback_query"] })
      });
      for (const update of updates.result || []) {
        if (typeof update.update_id === "number") state.telegramUpdateOffset = update.update_id + 1;
        const chatId = String(update.message?.chat?.id || update.callback_query?.message?.chat?.id || "");
        const userId = String(update.message?.from?.id || update.callback_query?.from?.id || "");
        if (!menuAllowed(settings, chatId, userId)) {
          if (update.callback_query?.id) {
            await answerCallback(settings, String(update.callback_query.id), "你没有使用机器人菜单的权限", true).catch(() => undefined);
          } else if (["/start", "/help"].includes(String(update.message?.text || "").split(/\s+/)[0].split("@")[0].toLowerCase())) {
            await sendBotText(settings, `你的 Telegram 用户 ID：<code>${escapeHtml(userId || chatId)}</code>\n请联系管理员将该 ID 加入“菜单用户 ID”。`, chatId).catch(() => undefined);
          }
          continue;
        }
        try {
          if (update.callback_query) await handleTelegramCallback(settings, state, update.callback_query);
          else if (update.message) await handleTelegramMessage(settings, state, update.message);
        } catch (error) {
          if (update.callback_query?.id) await answerCallback(settings, String(update.callback_query.id), (error as Error).message.slice(0, 180), true).catch(() => undefined);
          await sendBotText(settings, `操作失败：${escapeHtml((error as Error).message)}`, chatId).catch(() => undefined);
          addLog(`Telegram 菜单操作失败：${(error as Error).message}`);
        }
      }
      await saveState(state);
    } catch (error) {
      addLog(`Telegram 菜单监听异常：${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
}

export function initializeTelegramBot() {
  void telegramMenuLoop();
}

export async function getTelegramIntegrationStatus() {
  const [settings, state] = await Promise.all([getTgBotConfig(), getState()]);
  const status: TgBotStatus = {
    version: config.version,
    running: polling,
    telegramRunning,
    lastTickAt,
    lastScanAt: state.lastScanAt,
    lastWebhookAt: state.lastWebhookAt,
    lastError: state.lastError,
    lastSummary: state.lastSummary,
    seenCount: Object.keys(state.seen).length,
    logs
  };
  return { directConfigured: botConfigured(settings), serviceReady: true, status };
}

export async function testTgBot(target: "emby" | "tmdb" | "douban" | "telegram" | "all") {
  const settings = await getTgBotConfig();
  const targets = target === "all" ? ["emby", "tmdb", "douban", "telegram"] : [target];
  const messages: string[] = [];
  for (const current of targets) {
    if (current === "emby") {
      const info = await embyGet(settings, "System/Info");
      messages.push(`Emby 连接成功：${info.ServerName || "Emby"} / ${info.Version || "unknown"}`);
    }
    if (current === "tmdb") {
      await tmdbGet(settings, "configuration");
      messages.push("TMDB 连接成功");
    }
    if (current === "douban") {
      const response = await fetch("https://movie.douban.com/j/subject_suggest?q=%E6%B5%81%E6%B5%AA%E5%9C%B0%E7%90%83", { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`豆瓣 HTTP ${response.status}`);
      messages.push("豆瓣备用连接成功");
    }
    if (current === "telegram") {
      const sent = await sendBotText(settings, "这是一条 TFEmby Web 测试信息");
      messages.push(`Telegram 测试消息已发送：${sent} 个会话`);
    }
  }
  return { messages };
}

export async function controlTgBot(action: "start" | "stop" | "scan") {
  if (action === "start") {
    polling = true;
    schedulePoll();
    return { status: "started" };
  }
  if (action === "stop") {
    polling = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    return { status: "stopped" };
  }
  return scanOnce(true);
}
