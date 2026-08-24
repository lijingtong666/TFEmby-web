import "dotenv/config";

export const config = {
  port: Number(process.env.PORT || 8787),
  appName: process.env.PUBLIC_APP_NAME || "TFEmby Web",
  dataDir: process.env.DATA_DIR || "data",
  embyServerUrl: process.env.EMBY_SERVER_URL || "",
  tmdbApiKey: process.env.TMDB_API_KEY || "",
  tmdbBearerToken: process.env.TMDB_BEARER_TOKEN || "",
  doubanApiBase: process.env.DOUBAN_API_BASE || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || "",
  telegramApiBase: cleanBaseUrl(process.env.TELEGRAM_API_BASE || "https://api.telegram.org"),
  tgBotUrl: cleanBaseUrl(process.env.TGBOT_URL || "http://tgbot:8099"),
  publicTgBotUrl: cleanBaseUrl(process.env.PUBLIC_TGBOT_URL || ""),
  tgBotPort: Number(process.env.TGBOT_PORT || 8099),
  embyClient: "TFEmby Web",
  embyDevice: "Web UI",
  embyDeviceId: process.env.EMBY_DEVICE_ID || "tfemby-web-browser",
  version: "0.1.0"
};

export function cleanBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}
