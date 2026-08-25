import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authStatus, linkEmbyUser, loginLocal, loginWithEmby, sessionFromAuthHeader, setupAdmin } from "./auth.js";
import { config, getWebSettings, loadRuntimeSettings, saveRuntimeSettings } from "./config.js";
import { fetchDoubanChart } from "./douban.js";
import {
  annotateChartItems,
  fetchEmbyImage,
  findPosterFallback,
  getFulfilledRequestIds,
  getLatestItems,
  getLibrarySeasonNumbers,
  getPlayedHistory,
  getResumeItems,
  getStats,
  loginToEmby,
  searchLibrary,
  sessionFromHeaders
} from "./emby.js";
import { createMediaRequest, fulfillMediaRequests, listActiveMediaRequests, listMediaRequests, setMediaRequestTelegramMessages, updateMediaRequest } from "./requests.js";
import { enrichChartPosters } from "./posters.js";
import { discoverTmdb, fetchTmdbChart, fetchTmdbImage, fetchTmdbItem, fetchTmdbSeasonDetails, fetchTmdbSeasons, hasMinimumVisibleScore, minimumVisibleScore, searchTmdb } from "./tmdb.js";
import {
  controlTgBot,
  getTgBotConfig,
  getNetworkLatencyStatus,
  getTelegramIntegrationStatus,
  handleEmbyWebhook,
  initializeTelegramBot,
  notifyRequestCreated,
  notifyRequestStatus,
  saveTgBotConfig,
  sendTelegramTest,
  testTgBot,
  telegramConfigured
} from "./telegram.js";
import type { TgBotConfig } from "./telegram.js";
import type { ChartItem, EmbySession, MediaRequest, RequestStatus } from "./types.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

const requestArchiveChecks = new Map<string, { checkedAt: number; loading?: Promise<MediaRequest[]> }>();

async function reconcileRequestArchive(session: EmbySession, force = false) {
  const key = `${session.serverUrl}:${session.userId}`;
  const cached = requestArchiveChecks.get(key);
  if (cached?.loading) return cached.loading;
  if (!force && cached && Date.now() - cached.checkedAt < 60_000) return [] as MediaRequest[];

  const loading = (async () => {
    const active = await listActiveMediaRequests();
    if (!active.length) return [] as MediaRequest[];
    const fulfilledIds = await getFulfilledRequestIds(session, active);
    const fulfilled = await fulfillMediaRequests(fulfilledIds);
    for (const request of fulfilled) {
      await notifyRequestStatus(request, request.statusUpdatedBy || "Emby 自动归档").catch((error: Error) => console.error(`Telegram archive notification failed: ${error.message}`));
    }
    return fulfilled;
  })();
  requestArchiveChecks.set(key, { checkedAt: Date.now(), loading });
  try {
    return await loading;
  } finally {
    requestArchiveChecks.set(key, { checkedAt: Date.now() });
  }
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
    timeZone: config.timeZone,
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
    notificationReady: Boolean(bot)
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
      embyUrl: web.embyServerUrl
    } as TgBotConfig;
    try {
      bot = await saveTgBotConfig(synchronizedBot);
    } catch (error) {
      warning = `Web 配置已保存，但机器人同步失败：${(error as Error).message}`;
    }
  }

  res.json({ web, bot, notificationReady: Boolean(bot), warning });
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

app.post("/api/admin/latency", asyncRoute(async (req, res) => {
  requireAdmin(req);
  res.json(await getNetworkLatencyStatus());
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
    const cleanUsername = String(username || "").trim();
    const cleanPassword = String(password || "");
    if (!cleanUsername || !cleanPassword) {
      res.status(400).json({ error: "用户名和密码不能为空。" });
      return;
    }

    try {
      res.json(await loginLocal(cleanUsername, cleanPassword));
      return;
    } catch (error) {
      if ((error as Error & { status?: number }).status !== 401) throw error;
    }

    if (!config.embyServerUrl) {
      res.status(401).json({ error: "用户名或密码错误，且管理员尚未配置 Emby 服务器。" });
      return;
    }

    try {
      const emby = await loginToEmby(config.embyServerUrl, cleanUsername, cleanPassword);
      res.json(await loginWithEmby(emby));
    } catch (error) {
      if ((error as Error & { status?: number }).status === 401) {
        res.status(401).json({ error: "用户名或密码错误。" });
        return;
      }
      throw error;
    }
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
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: "用户名和密码不能为空。" });
      return;
    }
    const emby = await loginToEmby(config.embyServerUrl, username, password);
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
  "/api/emby/image",
  asyncRoute(async (req, res) => {
    const itemId = scalar(req.query.itemId, "");
    const kind = scalar(req.query.kind, "Primary") === "Backdrop" ? "Backdrop" : "Primary";
    const width = Number(req.query.width);
    const image = await fetchEmbyImage(requireSession(req), itemId, kind, Number.isFinite(width) ? width : undefined);
    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Cache-Control", "private, max-age=3600, stale-while-revalidate=86400");
    res.send(image.body);
  })
);

app.get(
  "/api/emby/poster-fallback",
  asyncRoute(async (req, res) => {
    requireSession(req);
    const title = scalar(req.query.title, "").trim();
    if (!title) {
      res.status(400).json({ error: "缺少影片名称。" });
      return;
    }
    const requestedYear = Number(req.query.year);
    const poster = await findPosterFallback({
      title,
      originalTitle: scalar(req.query.originalTitle, "") || undefined,
      mediaType: scalar(req.query.mediaType, "tv") === "movie" ? "movie" : "tv",
      year: Number.isInteger(requestedYear) ? requestedYear : undefined,
      tmdbId: scalar(req.query.tmdbId, "") || undefined
    });
    if (!poster) {
      res.status(404).json({ error: "没有找到备用封面。" });
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=3600, stale-while-revalidate=86400");
    res.redirect(302, poster);
  })
);

app.get(
  "/api/tmdb/discover",
  asyncRoute(async (req, res) => {
    const mediaType = scalar(req.query.media, "movie") === "tv" ? "tv" : "movie";
    const page = Math.min(5, Math.max(1, Number(req.query.page) || 1));
    const requestedYear = Number(req.query.year);
    const year = Number.isInteger(requestedYear) && requestedYear >= 1900 && requestedYear <= new Date().getFullYear() + 2 ? requestedYear : undefined;
    const requestedGenre = Number(req.query.genre);
    const genre = Number.isInteger(requestedGenre) && requestedGenre > 0 ? requestedGenre : undefined;
    const requestedScore = Number(req.query.minScore);
    const minScore = Number.isFinite(requestedScore) && requestedScore <= 10 ? Math.max(minimumVisibleScore, requestedScore) : minimumVisibleScore;
    const requestedLanguage = scalar(req.query.language, "").toLowerCase();
    const language = /^[a-z]{2}$/.test(requestedLanguage) ? requestedLanguage : undefined;
    const requestedSort = scalar(req.query.sort, "popular-desc");
    const sortOptions = ["popular-desc", "popular-asc", "score-desc", "release-desc", "release-asc"] as const;
    const sort = sortOptions.find((value) => value === requestedSort) || "popular-desc";
    const session = sessionFromAuthHeader(req.headers.authorization)?.emby || sessionFromHeaders(req.headers);
    const result = await discoverTmdb(mediaType, { page, year, genre, minScore, language, sort });
    const items = await annotateChartItems(session, await enrichChartPosters(result.items.filter(hasMinimumVisibleScore)));
    res.json({ ...result, items });
  })
);

app.get(
  "/api/charts/:source/:chart",
  asyncRoute(async (req, res) => {
    const source = scalar(req.params.source, "tmdb");
    const chart = scalar(req.params.chart, "global");
    const media = scalar(req.query.media, "all");
    const period = scalar(req.query.period, "week");
    const page = Math.min(5, Math.max(1, Number(req.query.page) || 1));
    const requestedYear = Number(req.query.year);
    const year = Number.isInteger(requestedYear) && requestedYear >= 1900 && requestedYear <= new Date().getFullYear() + 2 ? requestedYear : undefined;
    const requestedGenre = Number(req.query.genre);
    const genre = Number.isInteger(requestedGenre) && requestedGenre > 0 ? requestedGenre : undefined;
    const session = sessionFromAuthHeader(req.headers.authorization)?.emby || sessionFromHeaders(req.headers);

    const result = source === "douban"
      ? await fetchDoubanChart(chart, media, period, page, year, genre)
      : await fetchTmdbChart(chart, media, period, { page, year, genre });
    const items = await annotateChartItems(session, await enrichChartPosters(result.items.filter(hasMinimumVisibleScore)));
    res.json({ ...result, items });
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
  "/api/tmdb/image",
  asyncRoute(async (req, res) => {
    const imagePath = scalar(req.query.path, "");
    const size = scalar(req.query.size, "w500");
    const response = await fetchTmdbImage(imagePath, size);
    res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    res.send(Buffer.from(await response.arrayBuffer()));
  })
);

app.get(
  "/api/tmdb/tv/:id/seasons",
  asyncRoute(async (req, res) => {
    const session = requireAppSession(req);
    const tmdbId = scalar(req.params.id, "");
    const { item, seasons } = await fetchTmdbSeasons(tmdbId);
    const librarySeasons = session.emby
      ? await getLibrarySeasonNumbers(session.emby, tmdbId, item.title, item.year)
      : new Set<number>();
    res.json(seasons.map((season) => ({ ...season, inLibrary: librarySeasons.has(season.seasonNumber) })));
  })
);

app.get(
  "/api/tmdb/:media/:id/details",
  asyncRoute(async (req, res) => {
    const mediaType = scalar(req.params.media, "movie") === "tv" ? "tv" : "movie";
    const tmdbId = scalar(req.params.id, "");
    const session = sessionFromAuthHeader(req.headers.authorization)?.emby || sessionFromHeaders(req.headers);
    if (mediaType === "tv") {
      const details = await fetchTmdbSeasons(tmdbId);
      const [item] = await annotateChartItems(session, [details.item]);
      const librarySeasons = session
        ? await getLibrarySeasonNumbers(session, tmdbId, details.item.title, details.item.year)
        : new Set<number>();
      res.json({
        item,
        seasons: details.seasons.map((season) => ({ ...season, inLibrary: librarySeasons.has(season.seasonNumber) }))
      });
      return;
    }
    const [item] = await annotateChartItems(session, [await fetchTmdbItem(tmdbId, "movie")]);
    res.json({ item, seasons: [] });
  })
);

app.get(
  "/api/tmdb/tv/:id/season/:seasonNumber",
  asyncRoute(async (req, res) => {
    const tmdbId = scalar(req.params.id, "");
    const seasonNumber = Number(req.params.seasonNumber);
    res.json(await fetchTmdbSeasonDetails(tmdbId, seasonNumber));
  })
);

app.get(
  "/api/requests",
  asyncRoute(async (req, res) => {
    const session = requireAppSession(req);
    if (session.emby) await reconcileRequestArchive(session.emby).catch((error: Error) => console.error(`Request archive check failed: ${error.message}`));
    res.json(await listMediaRequests(session));
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
    let item: ChartItem;
    let season: { seasonNumber: number; seasonName: string; episodeCount?: number } | undefined;
    if (mediaType === "tv") {
      const seasonNumber = Number(req.body?.seasonNumber);
      if (!Number.isInteger(seasonNumber) || seasonNumber <= 0) {
        res.status(400).json({ error: "请选择要申请的季度。" });
        return;
      }
      const details = await fetchTmdbSeasons(tmdbId);
      item = details.item;
      const selected = details.seasons.find((candidate) => candidate.seasonNumber === seasonNumber);
      if (!selected) {
        res.status(404).json({ error: "TMDB 中未找到该季度。" });
        return;
      }
      if (session.emby) {
        const librarySeasons = await getLibrarySeasonNumbers(session.emby, tmdbId, item.title, item.year);
        if (librarySeasons.has(seasonNumber)) {
          res.status(409).json({ error: `第 ${seasonNumber} 季已在媒体库中。` });
          return;
        }
      }
      season = { seasonNumber, seasonName: selected.name, episodeCount: selected.episodeCount };
    } else {
      item = await fetchTmdbItem(tmdbId, mediaType);
    }
    let created = await createMediaRequest(session, item, season);
    const notified = await notifyRequestCreated(created).catch((error: Error) => {
      console.error(`Telegram request notification failed: ${error.message}`);
      return null;
    });
    if (notified?.messages.length) created = (await setMediaRequestTelegramMessages(created.id, notified.messages)) || created;
    res.status(201).json(created);
  })
);

app.patch(
  "/api/requests/:id",
  asyncRoute(async (req, res) => {
    const admin = requireAdmin(req);
    const id = scalar(req.params.id, "");
    let updated = await updateMediaRequest(id, String(req.body?.status || "") as RequestStatus, admin.username);
    await notifyRequestStatus(updated, admin.username).catch((error: Error) => console.error(`Telegram status notification failed: ${error.message}`));
    if (updated.status === "approved" && admin.emby) {
      const archived = await reconcileRequestArchive(admin.emby, true).catch(() => [] as MediaRequest[]);
      updated = archived.find((item) => item.id === updated.id) || updated;
    }
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
    const action = scalar(req.params.action, "") as "start" | "stop" | "scan" | "menu";
    if (!(["start", "stop", "scan", "menu"] as string[]).includes(action)) {
      res.status(400).json({ error: "机器人操作无效。" });
      return;
    }
    res.json(await controlTgBot(action));
  })
);

app.post(
  "/webhook/emby",
  asyncRoute(async (req, res) => {
    const token = scalar(req.query.token || req.query.secret, "");
    let payload = req.body || {};
    const encodedPayload = typeof payload.data === "string" ? payload.data : typeof payload.payload === "string" ? payload.payload : "";
    if (encodedPayload) {
      try {
        payload = JSON.parse(encodedPayload);
      } catch {
        // Keep the original form body when the nested value is not JSON.
      }
    }
    res.json(await handleEmbyWebhook(payload, req.headers, token));
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
initializeTelegramBot();

app.listen(config.port, () => {
  console.log(`TFEmby Web API listening on http://127.0.0.1:${config.port}`);
});
