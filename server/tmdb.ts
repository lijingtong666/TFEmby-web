import { config } from "./config.js";
import type { ChartItem } from "./types.js";

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
};

type TmdbResponse = {
  results?: TmdbMedia[];
};

const image = (path?: string, size = "w500") => (path ? `https://image.tmdb.org/t/p/${size}${path}` : undefined);

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
  const response = await fetch(endpoint, { headers: headers() });
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
  const response = await fetch(endpoint, { headers: headers() });
  if (!response.ok) {
    const error = new Error(response.status === 404 ? "TMDB 中未找到该条目。" : "TMDB 条目读取失败。");
    (error as Error & { status?: number }).status = response.status === 404 ? 404 : 502;
    throw error;
  }
  const media = (await response.json()) as TmdbMedia;
  media.media_type = mediaType;
  return toChartItem(media, "request", 0);
}

export async function findTmdbPoster(item: ChartItem): Promise<string | undefined> {
  if (!config.tmdbApiKey && !config.tmdbBearerToken) return undefined;

  try {
    const endpoint = withKey(new URL(`/3/search/${item.mediaType}`, "https://api.themoviedb.org"));
    endpoint.searchParams.set("query", item.title);
    if (item.year) endpoint.searchParams.set(item.mediaType === "tv" ? "first_air_date_year" : "year", String(item.year));
    const response = await fetch(endpoint, { headers: headers(), signal: AbortSignal.timeout(5000) });
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
  const url = new URL("https://api.themoviedb.org/3");
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

  const endpoint = withKey(new URL(path, url));
  if (chart === "monthly") {
    endpoint.searchParams.set("sort_by", "popularity.desc");
    if (media === "tv") endpoint.searchParams.set("first_air_date.gte", lastMonth());
    else endpoint.searchParams.set("primary_release_date.gte", lastMonth());
  }
  const response = await fetch(endpoint, { headers: headers() });
  if (!response.ok) return fallback(chart);
  const data = (await response.json()) as TmdbResponse;
  return (data.results || []).slice(0, 24).map((item, index) => toChartItem(item, chart, index + 1));
}
