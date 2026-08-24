import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authStatus, linkEmbyUser, loginLocal, loginWithEmby, sessionFromAuthHeader, setupAdmin } from "./auth.js";
import { config, getWebSettings, loadRuntimeSettings, saveRuntimeSettings } from "./config.js";
import { fetchDoubanChart } from "./douban.js";
import {
  annotateChartItems,
  getLatestItems,
  getPlayedHistory,
  getResumeItems,
  getStats,
  loginToEmby,
  searchLibrary,
  sessionFromHeaders
} from "./emby.js";
import { createMediaRequest, listMediaRequests, updateMediaRequest } from "./requests.js";
import { enrichChartPosters } from "./posters.js";
import { fetchTmdbChart, fetchTmdbItem, searchTmdb } from "./tmdb.js";
import {
  controlTgBot,
  getTgBotConfig,
  getTelegramIntegrationStatus,
  notifyRequestCreated,
  notifyRequestStatus,
  saveTgBotConfig,
  sendTelegramTest,
  testTgBot,
  telegramConfigured
} from "./telegram.js";
import type { TgBotConfig } from "./telegram.js";
import type { RequestStatus } from "./types.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireSession(req: express.Request) {
  const appSession = sessionFromAuthHeader(req.headers.authorization);
  const session = appSession?.emby || sessionFromHeaders(req.headers);
  if (!session) {
    const error = new Error("请先使用已关联 Emby 的用户登录。");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
  return session;
}

function requireAppSession(req: express.Request) {
  const session = sessionFromAuthHeader(req.headers.authorization);
  if (!session) {
    const error = new Error("请先登录。");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
  return session;
}

function requireAdmin(req: express.Request) {
  const session = requireAppSession(req);
  if (session.role !== "admin") {
    const error = new Error("仅管理员可以执行此操作。");
    (error as Error & { status?: number }).status = 403;
    throw error;
  }
  return session;
}

function scalar(value: unknown, fallback: string) {
  if (Array.isArray(value)) return String(value[0] || fallback);
  return String(value || fallback);
}

function doubanImageUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const allowed = hostname === "douban.com" || hostname.endsWith(".douban.com") || hostname === "doubanio.com" || hostname.endsWith(".doubanio.com");
    return allowed && (url.protocol === "https:" || url.protocol === "http:") ? url : null;
  } catch {
    return null;
  }
}

app.get("/api/config", asyncRoute(async (_req, res) => {
  const status = await authStatus();
  res.json({
    appName: config.appName,
    version: config.version,
    embyServerUrl: config.embyServerUrl,
    tmdbEnabled: Boolean(config.tmdbApiKey || config.tmdbBearerToken),
    doubanEnabled: Boolean(config.doubanApiBase),
    telegramEnabled: telegramConfigured(),
    requiresSetup: status.requiresSetup
  });
}));

app.get("/api/admin/settings", asyncRoute(async (req, res) => {
  requireAdmin(req);
  const bot = await getTgBotConfig().catch(() => null);
  res.json({
    web: getWebSettings(),
    bot,
    sidecarReachable: Boolean(bot)
  });
}));

app.put("/api/admin/settings", asyncRoute(async (req, res) => {
  requireAdmin(req);
  const web = await saveRuntimeSettings(req.body?.web || {});
  const requestedBot = req.body?.bot as Partial<TgBotConfig> | undefined;
  let bot: TgBotConfig | null = null;
  let warning = "";

  if (requestedBot) {
    const synchronizedBot = {
      ...requestedBot,
      telegramBotToken: web.telegramBotToken,
      telegramChatId: web.telegramChatId,
      tmdbApiKey: web.tmdbApiKey,
      embyUrl: web.embyServerUrl,
      publicBaseUrl: web.publicTgBotUrl
    } as TgBotConfig;
    try {
      bot = await saveTgBotConfig(synchronizedBot);
    } catch (error) {
      warning = `Web 配置已保存，但机器人同步失败：${(error as Error).message}`;
    }
  }

  res.json({ web, bot, sidecarReachable: Boolean(bot), warning });
}));

app.post("/api/admin/settings/test/:target", asyncRoute(async (req, res) => {
  requireAdmin(req);
  const target = scalar(req.params.target, "") as "emby" | "tmdb" | "douban" | "telegram" | "all";
  if (!("emby,tmdb,douban,telegram,all".split(",") as string[]).includes(target)) {
    res.status(400).json({ error: "测试项目无效。" });
    return;
  }
  res.json(await testTgBot(target));
}));

app.post(
  "/api/auth/setup",
  asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    res.json(await setupAdmin(String(username || ""), String(password || "")));
  })
);

app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    res.json(await loginLocal(String(username || ""), String(password || "")));
  })
);

app.post(
  "/api/auth/emby",
  asyncRoute(async (req, res) => {
    const { serverUrl, username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: "用户名和密码不能为空。" });
      return;
    }
    const emby = await loginToEmby(serverUrl, username, password);
    res.json(await loginWithEmby(emby));
  })
);

app.post(
  "/api/auth/link-emby",
  asyncRoute(async (req, res) => {
    const session = requireAppSession(req);
    const { serverUrl, username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: "用户名和密码不能为空。" });
      return;
    }
    const emby = await loginToEmby(serverUrl, username, password);
    res.json(await linkEmbyUser(session.userId, emby));
  })
);

app.post(
  "/api/emby/login",
  asyncRoute(async (req, res) => {
    const { serverUrl, username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: "用户名和密码不能为空。" });
      return;
    }
    const emby = await loginToEmby(serverUrl, username, password);
    res.json(await loginWithEmby(emby));
  })
);

app.get(
  "/api/emby/stats",
  asyncRoute(async (req, res) => {
    res.json(await getStats(requireSession(req)));
  })
);

app.get(
  "/api/emby/search",
  asyncRoute(async (req, res) => {
    const query = String(req.query.q || "");
    res.json(await searchLibrary(requireSession(req), query));
  })
);

app.get(
  "/api/emby/resume",
  asyncRoute(async (req, res) => {
    res.json(await getResumeItems(requireSession(req)));
  })
);

app.get(
  "/api/emby/history",
  asyncRoute(async (req, res) => {
    res.json(await getPlayedHistory(requireSession(req)));
  })
);

app.get(
  "/api/emby/latest",
  asyncRoute(async (req, res) => {
    res.json(await getLatestItems(requireSession(req)));
  })
);

app.get(
  "/api/charts/:source/:chart",
  asyncRoute(async (req, res) => {
    const source = scalar(req.params.source, "tmdb");
    const chart = scalar(req.params.chart, "global");
    const media = scalar(req.query.media, "all");
    const period = scalar(req.query.period, "week");
    const session = sessionFromAuthHeader(req.headers.authorization)?.emby || sessionFromHeaders(req.headers);

    const items =
      source === "douban" ? await fetchDoubanChart(chart, media, period) : await fetchTmdbChart(chart, media, period);
    res.json(await annotateChartItems(session, await enrichChartPosters(items)));
  })
);

app.get(
  "/api/poster-proxy",
  asyncRoute(async (req, res) => {
    let target = doubanImageUrl(String(req.query.url || ""));
    if (!target) {
      res.status(400).json({ error: "海报地址无效。" });
      return;
    }

    let response = await fetch(target, {
      redirect: "manual",
      headers: { Referer: "https://movie.douban.com/", "User-Agent": "Mozilla/5.0 (TFEmby Web poster proxy)" },
      signal: AbortSignal.timeout(8000)
    });
    if (response.status >= 300 && response.status < 400) {
      const redirected = doubanImageUrl(new URL(response.headers.get("location") || "", target).toString());
      if (!redirected) {
        res.status(502).json({ error: "豆瓣海报跳转地址无效。" });
        return;
      }
      target = redirected;
      response = await fetch(target, {
        headers: { Referer: "https://movie.douban.com/", "User-Agent": "Mozilla/5.0 (TFEmby Web poster proxy)" },
        signal: AbortSignal.timeout(8000)
      });
    }
    if (!response.ok) {
      res.status(502).json({ error: "豆瓣海报读取失败。" });
      return;
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 10 * 1024 * 1024) {
      res.status(413).json({ error: "海报文件过大。" });
      return;
    }
    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      res.status(502).json({ error: "豆瓣返回的不是图片。" });
      return;
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    res.send(Buffer.from(await response.arrayBuffer()));
  })
);

app.get(
  "/api/tmdb/search",
  asyncRoute(async (req, res) => {
    requireAppSession(req);
    const query = String(req.query.q || "").trim();
    if (!query) {
      res.json([]);
      return;
    }
    res.json(await searchTmdb(query));
  })
);

app.get(
  "/api/requests",
  asyncRoute(async (req, res) => {
    res.json(await listMediaRequests(requireAppSession(req)));
  })
);

app.post(
  "/api/requests",
  asyncRoute(async (req, res) => {
    const session = requireAppSession(req);
    const tmdbId = String(req.body?.tmdbId || "");
    const mediaType = req.body?.mediaType === "tv" ? "tv" : req.body?.mediaType === "movie" ? "movie" : null;
    if (!tmdbId || !mediaType) {
      res.status(400).json({ error: "请选择有效的 TMDB 电影或剧集。" });
      return;
    }
    const item = await fetchTmdbItem(tmdbId, mediaType);
    const created = await createMediaRequest(session, item);
    await notifyRequestCreated(created).catch((error: Error) => console.error(`Telegram request notification failed: ${error.message}`));
    res.status(201).json(created);
  })
);

app.patch(
  "/api/requests/:id",
  asyncRoute(async (req, res) => {
    const admin = requireAdmin(req);
    const id = scalar(req.params.id, "");
    const updated = await updateMediaRequest(id, String(req.body?.status || "") as RequestStatus);
    await notifyRequestStatus(updated, admin.username).catch((error: Error) => console.error(`Telegram status notification failed: ${error.message}`));
    res.json(updated);
  })
);

app.get(
  "/api/integrations/telegram",
  asyncRoute(async (req, res) => {
    requireAdmin(req);
    res.json(await getTelegramIntegrationStatus());
  })
);

app.post(
  "/api/integrations/telegram/test",
  asyncRoute(async (req, res) => {
    requireAdmin(req);
    if (!telegramConfigured()) {
      res.status(400).json({ error: "请先在管理后台配置 Telegram Bot Token 和 Chat ID。" });
      return;
    }
    res.json(await sendTelegramTest());
  })
);

app.post(
  "/api/integrations/telegram/:action",
  asyncRoute(async (req, res) => {
    requireAdmin(req);
    const action = scalar(req.params.action, "") as "start" | "stop" | "scan";
    if (!(["start", "stop", "scan"] as string[]).includes(action)) {
      res.status(400).json({ error: "机器人操作无效。" });
      return;
    }
    res.json(await controlTgBot(action));
  })
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const clientDist = path.resolve(__dirname, "../client");
app.use(express.static(clientDist));
app.get(/.*/, (_req, res, next) => {
  const indexPath = path.join(clientDist, "index.html");
  res.sendFile(indexPath, (error) => {
    if (error) next();
  });
});

app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.status || 500).json({
    error: error.message || "服务器请求失败。"
  });
});

await loadRuntimeSettings();

app.listen(config.port, () => {
  console.log(`TFEmby Web API listening on http://127.0.0.1:${config.port}`);
});
