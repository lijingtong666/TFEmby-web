import "dotenv/config";
import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultTimeZone = "Asia/Shanghai";
process.env.TZ ||= defaultTimeZone;

export type WebSettings = {
  appName: string;
  embyServerUrl: string;
  tmdbApiKey: string;
  tmdbBearerToken: string;
  tmdbApiBases: string;
  tmdbImageBases: string;
  doubanApiBase: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramApiBase: string;
  proxyEnabled: boolean;
  proxyUrl: string;
};

type RuntimeConfig = WebSettings & {
  port: number;
  dataDir: string;
  embyClient: string;
  embyDevice: string;
  embyDeviceId: string;
  version: string;
  timeZone: string;
};

export function cleanBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

const defaultTmdbApiBases = "https://api.themoviedb.org";
const defaultTmdbImageBases = "https://image.tmdb.org";

function splitUrlList(value: string) {
  return value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeUrlList(value: unknown, label: string, fallback: string) {
  const entries = splitUrlList(String(value ?? fallback));
  const normalized = entries.map((entry) => normalizeUrl(/^https?:\/\//i.test(entry) ? entry : `https://${entry}`, label));
  return Array.from(new Set(normalized.length ? normalized : [fallback])).join("\n");
}

export function getTmdbApiBases() {
  return splitUrlList(config.tmdbApiBases || defaultTmdbApiBases);
}

export function getTmdbImageBases() {
  return splitUrlList(config.tmdbImageBases || defaultTmdbImageBases);
}

export function tmdbApiUrl(base: string, endpoint: string) {
  const root = cleanBaseUrl(base);
  const apiRoot = /\/3$/i.test(root) ? root : `${root}/3`;
  return new URL(`${apiRoot}/${endpoint.replace(/^\/+/, "")}`);
}

export function tmdbImageUrl(base: string, size: string, imagePath: string) {
  return `${cleanBaseUrl(base)}/t/p/${size}${imagePath}`;
}

export const config: RuntimeConfig = {
  port: Number(process.env.PORT || 8787),
  appName: process.env.PUBLIC_APP_NAME || "TFEmby Web",
  dataDir: process.env.DATA_DIR || "data",
  embyServerUrl: cleanBaseUrl(process.env.EMBY_SERVER_URL || ""),
  tmdbApiKey: process.env.TMDB_API_KEY || "",
  tmdbBearerToken: process.env.TMDB_BEARER_TOKEN || "",
  tmdbApiBases: normalizeUrlList(process.env.TMDB_API_BASES || process.env.TMDB_API_BASE, "TMDB API 地址", defaultTmdbApiBases),
  tmdbImageBases: normalizeUrlList(process.env.TMDB_IMAGE_BASES || process.env.TMDB_IMAGE_BASE, "TMDB 图片地址", defaultTmdbImageBases),
  doubanApiBase: cleanBaseUrl(process.env.DOUBAN_API_BASE || ""),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || "",
  telegramApiBase: cleanBaseUrl(process.env.TELEGRAM_API_BASE || "https://api.telegram.org"),
  proxyEnabled: ["1", "true", "yes", "on"].includes(String(process.env.PROXY_ENABLED || "").toLowerCase()),
  proxyUrl: cleanBaseUrl(process.env.PROXY_URL || ""),
  embyClient: "TFEmby Web",
  embyDevice: "Web UI",
  embyDeviceId: process.env.EMBY_DEVICE_ID || "tfemby-web-browser",
  version: process.env.APP_VERSION || "0.6.8",
  timeZone: process.env.TZ || defaultTimeZone
};

const settingsPath = path.resolve(config.dataDir, "settings.json");
let settingsQueue: Promise<unknown> = Promise.resolve();

function normalizeUrl(value: unknown, label: string, fallback = "") {
  const normalized = cleanBaseUrl(String(value ?? fallback));
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return normalized;
  } catch {
    const error = new Error(`${label}必须是有效的 HTTP 或 HTTPS 地址。`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
}

function normalizedSettings(input: Partial<WebSettings>): WebSettings {
  const appName = String(input.appName ?? config.appName).trim();
  if (!appName || appName.length > 80) {
    const error = new Error("项目名称不能为空且不能超过 80 个字符。");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }

  const proxyEnabled = Boolean(input.proxyEnabled ?? config.proxyEnabled);
  const proxyUrl = normalizeUrl(input.proxyUrl, "代理地址", config.proxyUrl);
  if (proxyEnabled && !proxyUrl) {
    const error = new Error("启用代理后必须填写 HTTP 或 HTTPS 代理地址。");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }

  return {
    appName,
    embyServerUrl: normalizeUrl(input.embyServerUrl, "Emby 地址"),
    tmdbApiKey: String(input.tmdbApiKey ?? config.tmdbApiKey).trim(),
    tmdbBearerToken: String(input.tmdbBearerToken ?? config.tmdbBearerToken).trim(),
    tmdbApiBases: normalizeUrlList(input.tmdbApiBases, "TMDB API 地址", config.tmdbApiBases || defaultTmdbApiBases),
    tmdbImageBases: normalizeUrlList(input.tmdbImageBases, "TMDB 图片地址", config.tmdbImageBases || defaultTmdbImageBases),
    doubanApiBase: normalizeUrl(input.doubanApiBase, "豆瓣 API 地址"),
    telegramBotToken: String(input.telegramBotToken ?? config.telegramBotToken).trim(),
    telegramChatId: String(input.telegramChatId ?? config.telegramChatId).trim(),
    telegramApiBase: normalizeUrl(input.telegramApiBase, "Telegram API 地址", "https://api.telegram.org") || "https://api.telegram.org",
    proxyEnabled,
    proxyUrl
  };
}

function applySettings(settings: WebSettings) {
  Object.assign(config, settings);
}

export function getWebSettings(): WebSettings {
  return {
    appName: config.appName,
    embyServerUrl: config.embyServerUrl,
    tmdbApiKey: config.tmdbApiKey,
    tmdbBearerToken: config.tmdbBearerToken,
    tmdbApiBases: config.tmdbApiBases,
    tmdbImageBases: config.tmdbImageBases,
    doubanApiBase: config.doubanApiBase,
    telegramBotToken: config.telegramBotToken,
    telegramChatId: config.telegramChatId,
    telegramApiBase: config.telegramApiBase,
    proxyEnabled: config.proxyEnabled,
    proxyUrl: config.proxyUrl
  };
}

export async function loadRuntimeSettings() {
  try {
    const stored = JSON.parse(await readFile(settingsPath, "utf8")) as Partial<WebSettings>;
    applySettings(normalizedSettings(stored));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function saveRuntimeSettings(input: Partial<WebSettings>) {
  const task = settingsQueue.then(async () => {
    const settings = normalizedSettings(input);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const tempPath = `${settingsPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, settingsPath);
    applySettings(settings);
    return getWebSettings();
  });
  settingsQueue = task.catch(() => undefined);
  return task;
}
