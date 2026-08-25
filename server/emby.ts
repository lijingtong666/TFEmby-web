import { cleanBaseUrl, config } from "./config.js";
import { findDoubanPoster } from "./douban.js";
import { fetchTmdbItem, fetchTmdbSeasonDetails, findTmdbPoster } from "./tmdb.js";
import type { ChartItem, EmbySession, LibraryMediaDetails, LibrarySeasonStatus, MediaItem, MediaRequest } from "./types.js";
import type { IncomingHttpHeaders } from "node:http";

type EmbyItem = {
  Id: string;
  Name: string;
  OriginalTitle?: string;
  Type: string;
  ProductionYear?: number;
  Overview?: string;
  DateCreated?: string;
  PremiereDate?: string;
  CommunityRating?: number;
  CriticRating?: number;
  ProviderIds?: Record<string, string>;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  SeriesId?: string;
  SeriesName?: string;
  SeriesPrimaryImageTag?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ChildCount?: number;
  RecursiveItemCount?: number;
  UserData?: {
    Played?: boolean;
    PlayCount?: number;
    LastPlayedDate?: string;
    PlaybackPositionTicks?: number;
  };
  RunTimeTicks?: number;
};

type EmbyItemsResponse = {
  Items?: EmbyItem[];
  TotalRecordCount?: number;
};

const authHeader = `MediaBrowser Client="${config.embyClient}", Device="${config.embyDevice}", DeviceId="${config.embyDeviceId}", Version="${config.version}"`;

function normalizeServer(serverUrl?: string) {
  const chosen = cleanBaseUrl(serverUrl || config.embyServerUrl);
  if (!chosen) {
    throw new Error("Emby server URL is not configured.");
  }
  return chosen;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(text || `${response.status} ${response.statusText}`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function embyFetch<T>(session: EmbySession, path: string, init?: RequestInit) {
  const serverUrl = normalizeServer(session.serverUrl);
  const separator = path.includes("?") ? "&" : "?";
  const url = `${serverUrl}${path}${separator}api_key=${encodeURIComponent(session.accessToken)}`;
  const response = await fetch(url, {
    ...init,
    signal: init?.signal || AbortSignal.timeout(15000),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });
  return readJson<T>(response);
}

export async function loginToEmby(serverUrl: string | undefined, username: string, password: string): Promise<EmbySession> {
  const baseUrl = normalizeServer(serverUrl);
  const response = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: authHeader
    },
    body: JSON.stringify({ Username: username, Pw: password })
  });
  const data = await readJson<{
    AccessToken: string;
    User: { Id: string; Name: string; Policy?: { IsAdministrator?: boolean } };
  }>(response);

  return {
    serverUrl: baseUrl,
    userId: data.User.Id,
    userName: data.User.Name,
    accessToken: data.AccessToken,
    isAdmin: Boolean(data.User.Policy?.IsAdministrator)
  };
}

function headerValue(headers: IncomingHttpHeaders, key: string) {
  const value = headers[key.toLowerCase()];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export function sessionFromHeaders(headers: IncomingHttpHeaders): EmbySession | null {
  const accessToken = headerValue(headers, "x-emby-token");
  const userId = headerValue(headers, "x-emby-user-id");
  const serverUrl = headerValue(headers, "x-emby-server-url") || config.embyServerUrl;
  const encodedUserName = headerValue(headers, "x-emby-user-name");
  let userName = encodedUserName || "Emby";
  try {
    userName = encodedUserName ? decodeURIComponent(encodedUserName) : "Emby";
  } catch {
    userName = encodedUserName || "Emby";
  }
  if (!accessToken || !userId || !serverUrl) return null;
  return {
    accessToken,
    userId,
    serverUrl: cleanBaseUrl(serverUrl),
    userName
  };
}

function imageUrl(item: EmbyItem, kind: "Primary" | "Backdrop") {
  let itemId = item.Id;
  let tag = kind === "Primary" ? item.ImageTags?.Primary : item.BackdropImageTags?.[0];
  if (kind === "Primary" && !tag && item.SeriesId && item.SeriesPrimaryImageTag) {
    itemId = item.SeriesId;
    tag = item.SeriesPrimaryImageTag;
  }
  if (!tag) return undefined;
  const params = new URLSearchParams({ itemId, kind, tag });
  return `/api/emby/image?${params.toString()}`;
}

function kind(type: string): MediaItem["type"] {
  if (type === "Movie") return "movie";
  if (type === "Series") return "series";
  if (type === "Episode") return "episode";
  return "all";
}

function progress(item: EmbyItem) {
  const runtime = item.RunTimeTicks || 0;
  const position = item.UserData?.PlaybackPositionTicks || 0;
  if (!runtime || !position) return undefined;
  return Math.min(99, Math.max(1, Math.round((position / runtime) * 100)));
}

function toMediaItem(_session: EmbySession, item: EmbyItem): MediaItem {
  return {
    id: item.Id,
    title: item.Name,
    originalTitle: item.OriginalTitle,
    type: kind(item.Type),
    year: item.ProductionYear,
    overview: item.Overview,
    poster: imageUrl(item, "Primary"),
    backdrop: imageUrl(item, "Backdrop"),
    dateCreated: item.DateCreated,
    premiereDate: item.PremiereDate,
    communityRating: item.CommunityRating,
    criticRating: item.CriticRating,
    seriesId: item.SeriesId,
    seriesName: item.SeriesName,
    seasonNumber: item.ParentIndexNumber,
    episodeNumber: item.IndexNumber,
    providerIds: item.ProviderIds || {},
    userData: {
      played: Boolean(item.UserData?.Played),
      playCount: item.UserData?.PlayCount || 0,
      lastPlayedDate: item.UserData?.LastPlayedDate,
      playbackPositionTicks: item.UserData?.PlaybackPositionTicks || 0,
      runtimeTicks: item.RunTimeTicks || 0,
      progressPercent: progress(item)
    }
  };
}

const fallbackPosterLoads = new Map<string, Promise<string | undefined>>();

async function fallbackPoster(item: MediaItem) {
  const mediaType = item.type === "movie" ? "movie" : "tv";
  const title = item.type === "episode" ? item.seriesName || item.title : item.title;
  const tmdbId = providerId(item, ["Tmdb", "TMDb"]);
  const key = `${mediaType}:${tmdbId || normalizeTitle(title)}:${item.year || ""}`;
  let loading = fallbackPosterLoads.get(key);
  if (!loading) {
    loading = (async () => {
      if (tmdbId && /^\d+$/.test(tmdbId)) {
        const poster = await fetchTmdbItem(tmdbId, mediaType).then((value) => value.poster).catch(() => undefined);
        if (poster) return poster;
      }
      const candidate: ChartItem = {
        source: "demo",
        chart: "emby-poster",
        rank: 0,
        title,
        originalTitle: item.originalTitle,
        mediaType,
        year: item.year,
        externalIds: { tmdb: tmdbId || undefined }
      };
      return (await findTmdbPoster(candidate)) || (await findDoubanPoster(candidate));
    })();
    fallbackPosterLoads.set(key, loading);
  }
  return loading;
}

function fallbackPosterUrl(item: MediaItem) {
  const title = item.type === "episode" ? item.seriesName || item.title : item.title;
  if (!title.trim()) return undefined;
  const params = new URLSearchParams({
    title,
    mediaType: item.type === "movie" ? "movie" : "tv"
  });
  if (item.originalTitle) params.set("originalTitle", item.originalTitle);
  if (item.year) params.set("year", String(item.year));
  const tmdbId = providerId(item, ["Tmdb", "TMDb"]);
  if (tmdbId) params.set("tmdbId", tmdbId);
  return `/api/emby/poster-fallback?${params.toString()}`;
}

export async function findPosterFallback(input: {
  title: string;
  originalTitle?: string;
  mediaType: "movie" | "tv";
  year?: number;
  tmdbId?: string;
}) {
  return fallbackPoster({
    id: `fallback-${input.mediaType}-${input.tmdbId || normalizeTitle(input.title)}`,
    title: input.title,
    originalTitle: input.originalTitle,
    type: input.mediaType === "movie" ? "movie" : "series",
    year: input.year,
    providerIds: input.tmdbId ? { Tmdb: input.tmdbId } : {}
  });
}

async function enrichMediaPosters(session: EmbySession, rawItems: EmbyItem[]) {
  const seriesLoads = new Map<string, Promise<EmbyItem | null>>();
  const mapped = await Promise.all(rawItems.map(async (raw) => {
    let item = toMediaItem(session, raw);
    if (!item.poster && raw.Type === "Episode" && raw.SeriesId) {
      let seriesLoad = seriesLoads.get(raw.SeriesId);
      if (!seriesLoad) {
        seriesLoad = embyFetch<EmbyItem>(session, `/Users/${session.userId}/Items/${encodeURIComponent(raw.SeriesId)}?Fields=${encodeURIComponent(fields)}`).catch(() => null);
        seriesLoads.set(raw.SeriesId, seriesLoad);
      }
      const series = await seriesLoad;
      if (series) {
        item = {
          ...item,
          poster: imageUrl(series, "Primary"),
          backdrop: item.backdrop || imageUrl(series, "Backdrop"),
          providerIds: { ...(series.ProviderIds || {}), ...item.providerIds },
          year: item.year || series.ProductionYear
        };
      }
    }
    return item;
  }));

  return enrichMappedPosters(mapped);
}

async function enrichMappedPosters(mapped: MediaItem[]) {
  const result: MediaItem[] = [];
  const concurrency = 6;
  for (let index = 0; index < mapped.length; index += concurrency) {
    result.push(...(await Promise.all(mapped.slice(index, index + concurrency).map(async (item) => {
      if (item.poster) {
        const posterFallback = fallbackPosterUrl(item);
        return posterFallback ? { ...item, posterFallback } : item;
      }
      const poster = await fallbackPoster(item).catch(() => undefined);
      return poster ? { ...item, poster } : item;
    }))));
  }
  return result;
}

export async function fetchEmbyImage(session: EmbySession, itemId: string, kind: "Primary" | "Backdrop", maxWidth?: number) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(itemId)) {
    const error = new Error("Emby 图片 ID 无效。");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  const chosenWidth = Math.min(1600, Math.max(120, maxWidth || (kind === "Primary" ? 500 : 1200)));
  const params = new URLSearchParams({ maxWidth: String(chosenWidth), quality: "90", api_key: session.accessToken });
  const response = await fetch(`${normalizeServer(session.serverUrl)}/Items/${encodeURIComponent(itemId)}/Images/${kind}?${params}`, {
    headers: { Accept: "image/avif,image/webp,image/*,*/*" },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    const error = new Error(`Emby 图片读取失败：HTTP ${response.status}`);
    (error as Error & { status?: number }).status = response.status === 404 ? 404 : 502;
    throw error;
  }
  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error("Emby 返回的不是图片。");
  return { body: Buffer.from(await response.arrayBuffer()), contentType };
}

const fields = [
  "ProviderIds",
  "UserData",
  "Overview",
  "DateCreated",
  "PremiereDate",
  "ProductionYear",
  "CommunityRating",
  "CriticRating",
  "ImageTags",
  "BackdropImageTags",
  "SeriesId",
  "SeriesName",
  "SeriesPrimaryImageTag",
  "ParentIndexNumber",
  "IndexNumber",
  "ChildCount",
  "RecursiveItemCount"
].join(",");

function requireItemId(itemId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(itemId)) {
    const error = new Error("Emby 媒体 ID 无效。");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
}

async function getLibraryRawItem(session: EmbySession, itemId: string) {
  requireItemId(itemId);
  return embyFetch<EmbyItem>(session, `/Users/${session.userId}/Items/${encodeURIComponent(itemId)}?Fields=${encodeURIComponent(fields)}`);
}

async function getSeriesRows(session: EmbySession, seriesId: string) {
  const seasonParams = new URLSearchParams({
    UserId: session.userId,
    ParentId: seriesId,
    IncludeItemTypes: "Season",
    Fields: fields,
    SortBy: "IndexNumber",
    SortOrder: "Ascending",
    Limit: "100"
  });
  const episodeParams = new URLSearchParams({
    UserId: session.userId,
    ParentId: seriesId,
    Recursive: "true",
    IncludeItemTypes: "Episode",
    Fields: fields,
    SortBy: "ParentIndexNumber,IndexNumber",
    SortOrder: "Ascending",
    Limit: "10000"
  });
  const [seasonData, episodeData] = await Promise.all([
    embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${seasonParams.toString()}`),
    embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${episodeParams.toString()}`)
  ]);
  return { seasons: seasonData.Items || [], episodes: episodeData.Items || [] };
}

export async function getLibraryMediaDetails(session: EmbySession, itemId: string): Promise<LibraryMediaDetails> {
  const rawItem = await getLibraryRawItem(session, itemId);
  if (rawItem.Type !== "Movie" && rawItem.Type !== "Series") {
    const error = new Error("仅支持查看电影或剧集详情。");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  const item = (await enrichMediaPosters(session, [rawItem]))[0] || toMediaItem(session, rawItem);
  if (rawItem.Type === "Movie") {
    return { item, seasons: [], totalSeasons: 0, totalEpisodes: 0, playedEpisodes: item.userData?.played ? 1 : 0 };
  }

  const rows = await getSeriesRows(session, rawItem.Id);
  const episodesBySeason = new Map<number, EmbyItem[]>();
  for (const episode of rows.episodes) {
    const seasonNumber = Number(episode.ParentIndexNumber);
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0) continue;
    episodesBySeason.set(seasonNumber, [...(episodesBySeason.get(seasonNumber) || []), episode]);
  }
  const seasonsByNumber = new Map<number, EmbyItem>();
  for (const season of rows.seasons) {
    const seasonNumber = Number(season.IndexNumber);
    if (Number.isInteger(seasonNumber) && seasonNumber >= 0) seasonsByNumber.set(seasonNumber, season);
  }
  const seasonNumbers = new Set([...seasonsByNumber.keys(), ...episodesBySeason.keys()]);
  const seasons: LibrarySeasonStatus[] = [...seasonNumbers]
    .sort((left, right) => left - right)
    .map((seasonNumber) => {
      const season = seasonsByNumber.get(seasonNumber);
      const episodes = episodesBySeason.get(seasonNumber) || [];
      const episodeCount = episodes.length || season?.RecursiveItemCount || season?.ChildCount || 0;
      const playedEpisodeCount = episodes.filter((episode) => episode.UserData?.Played).length;
      return {
        id: season?.Id,
        name: season?.Name || (seasonNumber === 0 ? "特别篇" : `第 ${seasonNumber} 季`),
        seasonNumber,
        episodeCount,
        playedEpisodeCount: episodes.length ? playedEpisodeCount : season?.UserData?.Played ? episodeCount : 0,
        played: episodes.length ? episodeCount > 0 && playedEpisodeCount >= episodeCount : Boolean(season?.UserData?.Played),
        poster: season ? imageUrl(season, "Primary") || item.poster : item.poster
      };
    });
  const regularSeasons = seasons.filter((season) => season.seasonNumber > 0);
  return {
    item,
    seasons,
    totalSeasons: regularSeasons.length || seasons.length,
    totalEpisodes: seasons.reduce((total, season) => total + season.episodeCount, 0),
    playedEpisodes: seasons.reduce((total, season) => total + season.playedEpisodeCount, 0)
  };
}

async function setPlayedItem(session: EmbySession, itemId: string, played: boolean) {
  requireItemId(itemId);
  await embyFetch<Record<string, unknown>>(session, `/Users/${session.userId}/PlayedItems/${encodeURIComponent(itemId)}`, {
    method: played ? "POST" : "DELETE"
  });
}

export async function setLibraryPlayedStatus(session: EmbySession, itemId: string, played: boolean, seasonNumber?: number) {
  const rawItem = await getLibraryRawItem(session, itemId);
  if (rawItem.Type === "Movie") {
    await setPlayedItem(session, rawItem.Id, played);
    return getLibraryMediaDetails(session, rawItem.Id);
  }
  if (rawItem.Type !== "Series") {
    const error = new Error("仅支持修改电影或剧集的观看状态。");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }

  const rows = await getSeriesRows(session, rawItem.Id);
  const episodeIds = rows.episodes
    .filter((episode) => seasonNumber === undefined || Number(episode.ParentIndexNumber) === seasonNumber)
    .map((episode) => episode.Id);
  let targetIds = episodeIds;
  if (!targetIds.length && seasonNumber !== undefined) {
    const season = rows.seasons.find((candidate) => Number(candidate.IndexNumber) === seasonNumber);
    if (!season) {
      const error = new Error("库中未找到该季。");
      (error as Error & { status?: number }).status = 404;
      throw error;
    }
    targetIds = [season.Id];
  }
  if (!targetIds.length) targetIds = [rawItem.Id];
  for (let index = 0; index < targetIds.length; index += 8) {
    await Promise.all(targetIds.slice(index, index + 8).map((targetId) => setPlayedItem(session, targetId, played)));
  }
  return getLibraryMediaDetails(session, rawItem.Id);
}

export async function searchLibrary(session: EmbySession, query: string, limit = 48) {
  const searchTerm = query.trim();
  if (!searchTerm) return [];
  const params = new URLSearchParams({
    UserId: session.userId,
    SearchTerm: searchTerm,
    Recursive: "true",
    IncludeItemTypes: "Movie,Series",
    Fields: fields,
    Limit: String(limit)
  });
  try {
    const data = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${params.toString()}`);
    const directMatches = (data.Items || []).filter((item) => item.Type === "Movie" || item.Type === "Series");
    if (directMatches.length) return enrichMediaPosters(session, directMatches);
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    if (status !== 400 && status !== 404) throw error;
  }

  const fallbackParams = new URLSearchParams({
    UserId: session.userId,
    Recursive: "true",
    IncludeItemTypes: "Movie,Series",
    Fields: fields,
    Limit: "5000"
  });
  const fallback = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${fallbackParams.toString()}`);
  const normalizedQuery = normalizeTitle(searchTerm);
  if (!normalizedQuery) return [];
  const matches = (fallback.Items || [])
    .filter((item) => item.Type === "Movie" || item.Type === "Series")
    .filter((item) => [item.Name, item.OriginalTitle, item.SeriesName].some((value) => normalizeTitle(value).includes(normalizedQuery)))
    .slice(0, limit);
  return enrichMediaPosters(session, matches);
}

export async function getResumeItems(session: EmbySession, limit = 30) {
  const params = new URLSearchParams({
    UserId: session.userId,
    IncludeItemTypes: "Movie,Episode",
    Fields: fields,
    Limit: String(limit)
  });
  const data = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items/Resume?${params.toString()}`);
  return enrichMediaPosters(session, data.Items || []);
}

export async function getLatestItems(session: EmbySession, limit = 36) {
  const params = new URLSearchParams({
    IncludeItemTypes: "Movie,Series,Episode",
    Fields: fields,
    Limit: String(limit)
  });
  const data = await embyFetch<EmbyItem[]>(session, `/Users/${session.userId}/Items/Latest?${params.toString()}`);
  const episodeGroups = new Map<string, EmbyItem[]>();
  const standalone: EmbyItem[] = [];

  for (const item of data || []) {
    if (item.Type !== "Episode") {
      standalone.push(item);
      continue;
    }
    const batchDate = (item.DateCreated || "unknown").slice(0, 10);
    const seriesKey = item.SeriesId || item.SeriesName || item.Id;
    const key = `${seriesKey}:${batchDate}`;
    episodeGroups.set(key, [...(episodeGroups.get(key) || []), item]);
  }

  const groupedEpisodes = await Promise.all(Array.from(episodeGroups.entries()).map(async ([key, episodes]) => {
    const first = episodes[0];
    let series: EmbyItem | null = null;
    if (first.SeriesId) {
      series = await embyFetch<EmbyItem>(session, `/Users/${session.userId}/Items/${encodeURIComponent(first.SeriesId)}?Fields=${encodeURIComponent(fields)}`).catch(() => null);
    }
    const media = toMediaItem(session, series || first);
    const latestDate = episodes.map((episode) => episode.DateCreated || "").sort().at(-1) || first.DateCreated;
    return {
      ...media,
      id: `latest-${key}`,
      title: first.SeriesName || series?.Name || first.Name,
      type: "series" as const,
      dateCreated: latestDate,
      seriesId: first.SeriesId,
      seriesName: first.SeriesName || series?.Name,
      recentEpisodeRange: formatEpisodeRange(episodes),
      recentEpisodeCount: episodes.length
    };
  }));

  const groupedSeriesIds = new Set(groupedEpisodes.map((item) => item.seriesId).filter(Boolean));
  const items = [
    ...standalone.filter((item) => item.Type !== "Series" || !groupedSeriesIds.has(item.Id)).map((item) => toMediaItem(session, item)),
    ...groupedEpisodes
  ]
    .sort((a, b) => (b.dateCreated || "").localeCompare(a.dateCreated || ""))
    .slice(0, limit);
  return enrichMappedPosters(items);
}

function formatEpisodeRange(episodes: EmbyItem[]) {
  const seasons = new Map<number, number[]>();
  for (const episode of episodes) {
    if (!Number.isInteger(episode.ParentIndexNumber) || !Number.isInteger(episode.IndexNumber)) continue;
    const seasonNumber = Number(episode.ParentIndexNumber);
    seasons.set(seasonNumber, [...(seasons.get(seasonNumber) || []), Number(episode.IndexNumber)]);
  }
  if (!seasons.size) return `本次入库 ${episodes.length} 集`;

  return Array.from(seasons.entries())
    .sort(([left], [right]) => left - right)
    .map(([seasonNumber, values]) => {
      const numbers = Array.from(new Set(values)).sort((left, right) => left - right);
      const ranges: string[] = [];
      let start = numbers[0];
      let end = numbers[0];
      for (const current of numbers.slice(1)) {
        if (current === end + 1) {
          end = current;
          continue;
        }
        ranges.push(start === end ? `第${start}集` : `第${start}集-第${end}集`);
        start = current;
        end = current;
      }
      ranges.push(start === end ? `第${start}集` : `第${start}集-第${end}集`);
      return `第${seasonNumber}季 ${ranges.join("、")}`;
    })
    .join(" · ");
}

export async function getPlayedHistory(session: EmbySession, limit = 36) {
  const params = new URLSearchParams({
    UserId: session.userId,
    Recursive: "true",
    Filters: "IsPlayed",
    IncludeItemTypes: "Movie,Series,Episode",
    SortBy: "DatePlayed",
    SortOrder: "Descending",
    Fields: fields,
    Limit: String(limit)
  });
  const data = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${params.toString()}`);
  return enrichMediaPosters(session, data.Items || []);
}

export async function getStats(session: EmbySession) {
  const queryCount = async (includeTypes: string, extra: Record<string, string> = {}) => {
    const params = new URLSearchParams({
      UserId: session.userId,
      Recursive: "true",
      IncludeItemTypes: includeTypes,
      Limit: "1",
      ...extra
    });
    const data = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${params.toString()}`);
    return data.TotalRecordCount || 0;
  };

  const resumeParams = new URLSearchParams({
    UserId: session.userId,
    IncludeItemTypes: "Movie,Episode",
    Fields: "UserData,RunTimeTicks",
    Limit: "100"
  });
  const [movies, series, played, resumeData] = await Promise.all([
    queryCount("Movie"),
    queryCount("Series"),
    queryCount("Movie,Series,Episode", { Filters: "IsPlayed" }),
    embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items/Resume?${resumeParams.toString()}`)
  ]);
  const resumeItems = resumeData.Items || [];
  const progressValues = resumeItems.map(progress).filter((value): value is number => value !== undefined);
  const resumeProgressPercent = progressValues.length
    ? Math.round(progressValues.reduce((total, value) => total + value, 0) / progressValues.length)
    : 0;

  return {
    movies,
    series,
    played,
    resume: resumeItems.length,
    resumeProgressPercent,
    latest: 0
  };
}

async function getLibraryIndex(session: EmbySession) {
  const params = new URLSearchParams({
    UserId: session.userId,
    Recursive: "true",
    IncludeItemTypes: "Movie,Series",
    Fields: fields,
    Limit: "5000"
  });
  const data = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${params.toString()}`);
  return (data.Items || []).map((item) => toMediaItem(session, item));
}

function normalizeTitle(value?: string) {
  return (value || "")
    .toLowerCase()
    .replace(/[：:·'".,，。！？!?()\[\]【】\s-]/g, "")
    .trim();
}

function providerId(item: MediaItem, keys: string[]) {
  const providerIds = item.providerIds || {};
  for (const key of keys) {
    const value = providerIds[key] || providerIds[key.toLowerCase()] || providerIds[key.toUpperCase()];
    if (value) return String(value);
  }
  return "";
}

export async function annotateChartItems(session: EmbySession | null, chartItems: ChartItem[]) {
  if (!session) return chartItems;

  const library = await getLibraryIndex(session);
  return chartItems.map((chartItem) => {
    const match = library.find((item) => {
      const tmdb = providerId(item, ["Tmdb", "TMDb"]);
      const imdb = providerId(item, ["Imdb", "IMDb"]);
      const douban = providerId(item, ["Douban"]);
      const sameTmdb = chartItem.externalIds.tmdb && tmdb === chartItem.externalIds.tmdb;
      const sameImdb = chartItem.externalIds.imdb && imdb === chartItem.externalIds.imdb;
      const sameDouban = chartItem.externalIds.douban && douban === chartItem.externalIds.douban;
      const sameTitle = normalizeTitle(item.title) === normalizeTitle(chartItem.title) && (!chartItem.year || item.year === chartItem.year);
      return Boolean(sameTmdb || sameImdb || sameDouban || sameTitle);
    });

    return {
      ...chartItem,
      libraryStatus: {
        inLibrary: Boolean(match),
        watched: Boolean(match?.userData?.played),
        progressPercent: match?.userData?.progressPercent,
        embyId: match?.id,
        lastPlayedDate: match?.userData?.lastPlayedDate
      }
    };
  });
}

export async function getLibrarySeasonNumbers(session: EmbySession, tmdbId: string, title: string, year?: number) {
  const library = await getLibraryIndex(session);
  const series = library.find((item) => {
    if (item.type !== "series") return false;
    const sameTmdb = tmdbId && providerId(item, ["Tmdb", "TMDb"]) === tmdbId;
    const sameTitle = [item.title, item.originalTitle].some((value) => normalizeTitle(value) === normalizeTitle(title)) && (!year || !item.year || item.year === year);
    return Boolean(sameTmdb || sameTitle);
  });
  if (!series) return new Set<number>();

  const seasonParams = new URLSearchParams({
    UserId: session.userId,
    ParentId: series.id,
    IncludeItemTypes: "Season",
    Fields: "IndexNumber",
    Limit: "100"
  });
  const seasonData = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${seasonParams.toString()}`);
  const seasonNumbers = new Set((seasonData.Items || []).map((item) => item.IndexNumber).filter((value): value is number => Number.isInteger(value) && Number(value) > 0));
  if (seasonNumbers.size) return seasonNumbers;

  const episodeParams = new URLSearchParams({
    UserId: session.userId,
    ParentId: series.id,
    Recursive: "true",
    IncludeItemTypes: "Episode",
    Fields: "ParentIndexNumber",
    Limit: "10000"
  });
  const episodeData = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${episodeParams.toString()}`);
  return new Set((episodeData.Items || []).map((item) => item.ParentIndexNumber).filter((value): value is number => Number.isInteger(value) && Number(value) > 0));
}

function matchesRequest(item: MediaItem, request: MediaRequest) {
  const sameTmdb = request.tmdbId && providerId(item, ["Tmdb", "TMDb"]) === request.tmdbId;
  const requestTitles = [request.title, request.originalTitle].map(normalizeTitle).filter(Boolean);
  const sameTitle = [item.title, item.originalTitle].map(normalizeTitle).some((title) => title && requestTitles.includes(title));
  const sameYear = !request.year || !item.year || request.year === item.year;
  return Boolean(sameTmdb || (sameTitle && sameYear));
}

async function seasonEpisodeCount(session: EmbySession, seriesId: string, seasonNumber: number) {
  const params = new URLSearchParams({
    UserId: session.userId,
    ParentId: seriesId,
    Recursive: "true",
    IncludeItemTypes: "Episode",
    Fields: "ParentIndexNumber,IndexNumber",
    Limit: "10000"
  });
  const data = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${params.toString()}`);
  return new Set((data.Items || [])
    .filter((item) => item.ParentIndexNumber === seasonNumber && Number.isInteger(item.IndexNumber) && Number(item.IndexNumber) > 0)
    .map((item) => Number(item.IndexNumber))).size;
}

export async function getFulfilledRequestIds(session: EmbySession, requests: MediaRequest[]) {
  if (!requests.length) return [];
  const library = await getLibraryIndex(session);
  const fulfilled: string[] = [];
  const concurrency = 4;

  for (let index = 0; index < requests.length; index += concurrency) {
    const matches = await Promise.all(requests.slice(index, index + concurrency).map(async (request) => {
      if (request.mediaType === "movie") {
        return library.some((item) => item.type === "movie" && matchesRequest(item, request));
      }
      if (!request.seasonNumber) return false;
      const series = library.find((item) => item.type === "series" && matchesRequest(item, request));
      if (!series) return false;
      let expectedEpisodes = request.expectedEpisodeCount || 0;
      if (!expectedEpisodes) {
        const details = await fetchTmdbSeasonDetails(request.tmdbId, request.seasonNumber).catch(() => null);
        expectedEpisodes = details?.episodeCount || details?.episodes.length || 0;
      }
      if (!expectedEpisodes) return false;
      const actualEpisodes = await seasonEpisodeCount(session, series.id, request.seasonNumber).catch(() => 0);
      return actualEpisodes >= expectedEpisodes;
    }));
    matches.forEach((matched, offset) => {
      if (matched) fulfilled.push(requests[index + offset].id);
    });
  }

  return fulfilled;
}
