import { config } from "./config.js";
import { externalServiceFetch } from "./proxy.js";
import type { ChartItem, TvSeason } from "./types.js";

type TmdbSeason = {
  season_number: number;
  name?: string;
  episode_count?: number;
  air_date?: string;
  poster_path?: string;
};

type TmdbMedia = {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  media_type?: "movie" | "tv";
  poster_path?: string;
  backdrop_path?: string;
  overview?: string;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  seasons?: TmdbSeason[];
};

type TmdbResponse = {
  results?: TmdbMedia[];
};

type CachedImage = {
  body: Buffer;
  contentType: string;
  expiresAt: number;
};

const imageCache = new Map<string, CachedImage>();
const imageLoads = new Map<string, Promise<CachedImage>>();
const imageCacheMaxBytes = 64 * 1024 * 1024;
let imageCacheBytes = 0;

const image = (imagePath?: string, size = "w500") => imagePath
  ? `/api/tmdb/image?path=${encodeURIComponent(imagePath)}&size=${encodeURIComponent(size)}`
  : undefined;

function headers() {
  if (config.tmdbBearerToken) {
    return { Authorization: `Bearer ${config.tmdbBearerToken}`, Accept: "application/json" };
  }
  return { Accept: "application/json" };
}

function withKey(url: URL) {
  url.searchParams.set("language", "zh-CN");
  if (config.tmdbApiKey && !config.tmdbBearerToken) {
    url.searchParams.set("api_key", config.tmdbApiKey);
  }
  return url;
}

function yearOf(media: TmdbMedia) {
  const date = media.release_date || media.first_air_date || "";
  return date ? Number(date.slice(0, 4)) : undefined;
}

function toChartItem(media: TmdbMedia, chart: string, rank: number): ChartItem {
  const mediaType: "movie" | "tv" = media.media_type === "tv" || media.name ? "tv" : "movie";
  return {
    source: "tmdb",
    chart,
    rank,
    title: media.title || media.name || "未命名",
    originalTitle: media.original_title || media.original_name,
    mediaType,
    year: yearOf(media),
    poster: image(media.poster_path),
    backdrop: image(media.backdrop_path, "w780"),
    overview: media.overview,
    voteAverage: media.vote_average,
    releaseDate: media.release_date || media.first_air_date,
    externalIds: {
      tmdb: String(media.id)
    }
  };
}

function requireTmdb() {
  if (!config.tmdbApiKey && !config.tmdbBearerToken) {
    const error = new Error("请先在管理后台配置 TMDB API Key 或 Bearer Token。");
    (error as Error & { status?: number }).status = 503;
    throw error;
  }
}

export async function searchTmdb(query: string): Promise<ChartItem[]> {
  requireTmdb();
  const endpoint = withKey(new URL("/3/search/multi", "https://api.themoviedb.org"));
  endpoint.searchParams.set("query", query.trim());
  endpoint.searchParams.set("include_adult", "false");
  const response = await externalServiceFetch(endpoint, { headers: headers() });
  if (!response.ok) {
    const error = new Error("TMDB 搜索失败，请稍后重试。");
    (error as Error & { status?: number }).status = 502;
    throw error;
  }
  const data = (await response.json()) as TmdbResponse;
  return (data.results || [])
    .filter((item) => item.media_type === "movie" || item.media_type === "tv")
    .slice(0, 24)
    .map((item, index) => toChartItem(item, "search", index + 1));
}

export async function fetchTmdbItem(tmdbId: string, mediaType: "movie" | "tv"): Promise<ChartItem> {
  requireTmdb();
  if (!/^\d+$/.test(tmdbId)) {
    const error = new Error("TMDB ID 无效。");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  const endpoint = withKey(new URL(`/3/${mediaType}/${tmdbId}`, "https://api.themoviedb.org"));
  const response = await externalServiceFetch(endpoint, { headers: headers() });
  if (!response.ok) {
    const error = new Error(response.status === 404 ? "TMDB 中未找到该条目。" : "TMDB 条目读取失败。");
    (error as Error & { status?: number }).status = response.status === 404 ? 404 : 502;
    throw error;
  }
  const media = (await response.json()) as TmdbMedia;
  media.media_type = mediaType;
  return toChartItem(media, "request", 0);
}

export async function fetchTmdbSeasons(tmdbId: string): Promise<{ item: ChartItem; seasons: TvSeason[] }> {
  requireTmdb();
  if (!/^\d+$/.test(tmdbId)) {
    const error = new Error("TMDB ID 无效。");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  const endpoint = withKey(new URL(`/3/tv/${tmdbId}`, "https://api.themoviedb.org"));
  const response = await externalServiceFetch(endpoint, { headers: headers() });
  if (!response.ok) {
    const error = new Error(response.status === 404 ? "TMDB 中未找到该剧集。" : "TMDB 季度信息读取失败。");
    (error as Error & { status?: number }).status = response.status === 404 ? 404 : 502;
    throw error;
  }
  const media = (await response.json()) as TmdbMedia;
  media.media_type = "tv";
  return {
    item: toChartItem(media, "request", 0),
    seasons: (media.seasons || [])
      .filter((season) => Number.isInteger(season.season_number) && season.season_number > 0)
      .map((season) => ({
        seasonNumber: season.season_number,
        name: season.name || `第 ${season.season_number} 季`,
        episodeCount: season.episode_count,
        airDate: season.air_date,
        poster: image(season.poster_path),
        inLibrary: false
      }))
  };
}

export async function findTmdbPoster(item: ChartItem): Promise<string | undefined> {
  if (!config.tmdbApiKey && !config.tmdbBearerToken) return undefined;

  try {
    const endpoint = withKey(new URL(`/3/search/${item.mediaType}`, "https://api.themoviedb.org"));
    endpoint.searchParams.set("query", item.title);
    if (item.year) endpoint.searchParams.set(item.mediaType === "tv" ? "first_air_date_year" : "year", String(item.year));
    const response = await externalServiceFetch(endpoint, { headers: headers(), signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const data = (await response.json()) as TmdbResponse;
    const match = (data.results || []).find((media) => media.poster_path);
    return image(match?.poster_path);
  } catch {
    return undefined;
  }
}

function fallback(chart: string): ChartItem[] {
  const titles = [
    ["怒之杀", "movie", "2026", "7.1"],
    ["蜘蛛侠：崭新之日", "movie", "2026", "7.9"],
    ["特别行动：母狮", "tv", "2023", "8.1"],
    ["奥德赛", "movie", "2026", "8.0"],
    ["侠探杰克", "tv", "2022", "8.1"],
    ["死神", "tv", "2004", "8.4"],
    ["末日地堡", "tv", "2023", "8.2"],
    ["沙丘：预言", "tv", "2024", "7.7"]
  ] as const;

  return titles.map(([title, mediaType, year, score], index) => ({
    source: "demo",
    chart,
    rank: index + 1,
    title,
    mediaType,
    year: Number(year),
    voteAverage: Number(score),
    overview: "在管理后台配置 TMDB API Key 或 Bearer Token 后将显示实时榜单。",
    externalIds: {
      tmdb: `demo-${index + 1}`
    }
  }));
}

function lastMonth() {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().slice(0, 10);
}

export async function fetchTmdbChart(chart: string, media = "all", period = "week"): Promise<ChartItem[]> {
  if (!config.tmdbApiKey && !config.tmdbBearerToken) return fallback(chart);

  let path = "";
  if (chart === "trending" || chart === "global") {
    path = `/trending/${media === "movie" || media === "tv" ? media : "all"}/${period === "day" ? "day" : "week"}`;
  } else if (chart === "movie-popular") {
    path = "/movie/popular";
  } else if (chart === "tv-popular") {
    path = "/tv/popular";
  } else if (chart === "movie-top-rated") {
    path = "/movie/top_rated";
  } else if (chart === "tv-top-rated") {
    path = "/tv/top_rated";
  } else if (chart === "now-playing") {
    path = "/movie/now_playing";
  } else if (chart === "monthly") {
    path = media === "tv" ? "/discover/tv" : "/discover/movie";
  } else {
    path = "/trending/all/week";
  }

  const endpoint = withKey(new URL(`/3${path}`, "https://api.themoviedb.org"));
  if (chart === "monthly") {
    endpoint.searchParams.set("sort_by", "popularity.desc");
    if (media === "tv") endpoint.searchParams.set("first_air_date.gte", lastMonth());
    else endpoint.searchParams.set("primary_release_date.gte", lastMonth());
  }
  const response = await externalServiceFetch(endpoint, { headers: headers() });
  if (!response.ok) return fallback(chart);
  const data = (await response.json()) as TmdbResponse;
  return (data.results || []).slice(0, 24).map((item, index) => toChartItem(item, chart, index + 1));
}

export async function fetchTmdbImage(imagePath: string, size = "w500") {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(imagePath)) {
    const error = new Error("TMDB 图片路径无效。");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  const allowedSizes = new Set(["w185", "w300", "w342", "w500", "w780", "original"]);
  const chosenSize = allowedSizes.has(size) ? size : "w500";
  const cacheKey = `${chosenSize}:${imagePath}`;
  const cached = imageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    imageCache.delete(cacheKey);
    imageCache.set(cacheKey, cached);
    return new Response(cached.body, { headers: { "Content-Type": cached.contentType, "X-TFEmby-Image-Cache": "HIT" } });
  }

  let loading = imageLoads.get(cacheKey);
  if (!loading) {
    loading = loadTmdbImage(`https://image.tmdb.org/t/p/${chosenSize}${imagePath}`);
    imageLoads.set(cacheKey, loading);
  }
  try {
    const loaded = await loading;
    cacheImage(cacheKey, loaded);
    return new Response(loaded.body, { headers: { "Content-Type": loaded.contentType, "X-TFEmby-Image-Cache": "MISS" } });
  } finally {
    imageLoads.delete(cacheKey);
  }
}

async function imageCandidate(url: string, proxied: boolean, controller: AbortController) {
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const fetcher = proxied ? externalServiceFetch : fetch;
    const response = await fetcher(url, {
      headers: { Accept: "image/avif,image/webp,image/*,*/*" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) throw new Error("返回内容不是图片");
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length || body.length > 10 * 1024 * 1024) throw new Error("图片大小无效");
    return { body, contentType, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadTmdbImage(url: string): Promise<CachedImage> {
  const directController = new AbortController();
  const proxyController = new AbortController();
  const candidates: Array<Promise<{ value: CachedImage; source: "direct" | "proxy" }>> = [
    imageCandidate(url, false, directController).then((value) => ({ value, source: "direct" as const }))
  ];
  if (config.proxyEnabled && config.proxyUrl) {
    candidates.push(imageCandidate(url, true, proxyController).then((value) => ({ value, source: "proxy" as const })));
  }
  try {
    const winner = await Promise.any(candidates);
    if (winner.source === "direct") proxyController.abort();
    else directController.abort();
    return winner.value;
  } catch {
    const error = new Error("TMDB 图片通过直连和代理均读取失败。");
    (error as Error & { status?: number }).status = 502;
    throw error;
  }
}

function cacheImage(key: string, value: CachedImage) {
  const existing = imageCache.get(key);
  if (existing) imageCacheBytes -= existing.body.byteLength;
  imageCache.set(key, value);
  imageCacheBytes += value.body.byteLength;
  while (imageCache.size > 120 || imageCacheBytes > imageCacheMaxBytes) {
    const oldestKey = imageCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = imageCache.get(oldestKey);
    imageCache.delete(oldestKey);
    imageCacheBytes -= oldest?.body.byteLength || 0;
  }
}
