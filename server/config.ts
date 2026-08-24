import "dotenv/config";
import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type WebSettings = {
  appName: string;
  embyServerUrl: string;
  tmdbApiKey: string;
  tmdbBearerToken: string;
  doubanApiBase: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramApiBase: string;
};

type RuntimeConfig = WebSettings & {
  port: number;
  dataDir: string;
  embyClient: string;
  embyDevice: string;
  embyDeviceId: string;
  version: string;
};

export function cleanBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export const config: RuntimeConfig = {
  port: Number(process.env.PORT || 8787),
  appName: process.env.PUBLIC_APP_NAME || "TFEmby Web",
  dataDir: process.env.DATA_DIR || "data",
  embyServerUrl: cleanBaseUrl(process.env.EMBY_SERVER_URL || ""),
  tmdbApiKey: process.env.TMDB_API_KEY || "",
  tmdbBearerToken: process.env.TMDB_BEARER_TOKEN || "",
  doubanApiBase: cleanBaseUrl(process.env.DOUBAN_API_BASE || ""),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || "",
  telegramApiBase: cleanBaseUrl(process.env.TELEGRAM_API_BASE || "https://api.telegram.org"),
  embyClient: "TFEmby Web",
  embyDevice: "Web UI",
  embyDeviceId: process.env.EMBY_DEVICE_ID || "tfemby-web-browser",
  version: process.env.APP_VERSION || "0.4.0"
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

  return {
    appName,
    embyServerUrl: normalizeUrl(input.embyServerUrl, "Emby 地址"),
    tmdbApiKey: String(input.tmdbApiKey ?? config.tmdbApiKey).trim(),
    tmdbBearerToken: String(input.tmdbBearerToken ?? config.tmdbBearerToken).trim(),
    doubanApiBase: normalizeUrl(input.doubanApiBase, "豆瓣 API 地址"),
    telegramBotToken: String(input.telegramBotToken ?? config.telegramBotToken).trim(),
    telegramChatId: String(input.telegramChatId ?? config.telegramChatId).trim(),
    telegramApiBase: normalizeUrl(input.telegramApiBase, "Telegram API 地址", "https://api.telegram.org") || "https://api.telegram.org"
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
    doubanApiBase: config.doubanApiBase,
    telegramBotToken: config.telegramBotToken,
    telegramChatId: config.telegramChatId,
    telegramApiBase: config.telegramApiBase
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
