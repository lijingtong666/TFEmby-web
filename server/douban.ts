import { config } from "./config.js";
import type { ChartItem, ChartPage } from "./types.js";

type DoubanSearchItem = {
  id?: string | number;
  title?: string;
  name?: string;
  year?: string | number;
  type?: string;
  img?: string;
  cover?: string;
  cover_url?: string;
  poster?: string;
  pic?: { normal?: string; large?: string };
  images?: { small?: string; medium?: string; large?: string };
};

const posterCache = new Map<string, { value?: string; expiresAt: number }>();

const top250 = [
  ["肖申克的救赎", "movie", "1994", "9.7", "1292052"],
  ["霸王别姬", "movie", "1993", "9.6", "1291546"],
  ["阿甘正传", "movie", "1994", "9.5", "1292720"],
  ["泰坦尼克号", "movie", "1997", "9.5", "1292722"],
  ["千与千寻", "movie", "2001", "9.4", "1291561"],
  ["这个杀手不太冷", "movie", "1994", "9.4", "1295644"],
  ["美丽人生", "movie", "1997", "9.5", "1292063"],
  ["星际穿越", "movie", "2014", "9.4", "1889243"]
] as const;

const weekly = [
  ["疾速追杀：芭蕾杀姬", "movie", "2025", "7.3", "weekly-1"],
  ["长安的荔枝", "movie", "2025", "7.5", "weekly-2"],
  ["人生切割术", "tv", "2022", "9.1", "weekly-3"],
  ["星期三", "tv", "2022", "7.8", "weekly-4"],
  ["国色芳华", "tv", "2025", "7.9", "weekly-5"],
  ["罗小黑战记2", "movie", "2025", "8.0", "weekly-6"]
] as const;

function demoRows(chart: string) {
  if (chart === "top250") return top250;
  return weekly;
}

function fallback(chart: string, media = "all", page = 1, year?: number): ChartPage {
  const items: ChartItem[] = demoRows(chart)
    .filter(([, type]) => media === "all" || type === media)
    .filter(([, , itemYear]) => !year || Number(itemYear) === year)
    .map(([title, mediaType, year, score, id], index) => ({
      source: "demo",
      chart,
      rank: (page - 1) * 20 + index + 1,
      title,
      mediaType,
      year: Number(year),
      voteAverage: Number(score),
      overview: "配置 DOUBAN_API_BASE 后可接入自己的豆瓣榜单数据源。",
      externalIds: {
        douban: id
      }
    }));
  return { items: page === 1 ? items : [], page, totalPages: 1, totalResults: items.length };
}

function normalizeImageUrl(value?: string) {
  if (!value) return undefined;
  if (value.startsWith("//")) return `https:${value}`;
  return value;
}

function imageOf(item: DoubanSearchItem) {
  return normalizeImageUrl(item.poster || item.cover || item.cover_url || item.img || item.pic?.large || item.pic?.normal || item.images?.large || item.images?.medium);
}

function proxyPoster(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname === "douban.com" || url.hostname.endsWith(".douban.com") || url.hostname === "doubanio.com" || url.hostname.endsWith(".doubanio.com")) {
      return `/api/poster-proxy?url=${encodeURIComponent(url.toString())}`;
    }
  } catch {
    return undefined;
  }
  return value;
}

function searchRows(data: unknown): DoubanSearchItem[] {
  if (Array.isArray(data)) return data as DoubanSearchItem[];
  if (!data || typeof data !== "object") return [];
  const value = data as { items?: DoubanSearchItem[]; subjects?: DoubanSearchItem[]; results?: DoubanSearchItem[] };
  return value.items || value.subjects || value.results || [];
}

function choosePoster(rows: DoubanSearchItem[], item: ChartItem) {
  const expectedYear = item.year ? String(item.year) : "";
  const sorted = [...rows].sort((a, b) => {
    const score = (candidate: DoubanSearchItem) => {
      const candidateTitle = candidate.title || candidate.name || "";
      const candidateYear = String(candidate.year || candidateTitle.match(/(?:19|20)\d{2}/)?.[0] || "");
      let value = imageOf(candidate) ? 2 : 0;
      if (candidateTitle === item.title) value += 3;
      else if (candidateTitle.startsWith(item.title)) value += 2;
      if (expectedYear && candidateYear === expectedYear) value += 2;
      return value;
    };
    return score(b) - score(a);
  });
  return proxyPoster(imageOf(sorted.find((candidate) => imageOf(candidate)) || {}));
}

async function customDoubanSearch(item: ChartItem) {
  if (!config.doubanApiBase) return undefined;
  const endpoint = new URL(config.doubanApiBase.replace(/\/+$/, "") + "/search");
  endpoint.searchParams.set("q", item.title);
  endpoint.searchParams.set("media", item.mediaType);
  if (item.year) endpoint.searchParams.set("year", String(item.year));
  const response = await fetch(endpoint, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(4000) });
  if (!response.ok) return undefined;
  return choosePoster(searchRows(await response.json()), item);
}

async function publicDoubanSearch(item: ChartItem) {
  const endpoint = new URL("https://movie.douban.com/j/subject_suggest");
  endpoint.searchParams.set("q", item.title);
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      Referer: "https://movie.douban.com/",
      "User-Agent": "Mozilla/5.0 (TFEmby Web poster lookup)"
    },
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) return undefined;
  return choosePoster(searchRows(await response.json()), item);
}

async function publicDoubanHtmlSearch(item: ChartItem) {
  const endpoint = new URL("https://search.douban.com/movie/subject_search");
  endpoint.searchParams.set("search_text", item.title);
  const response = await fetch(endpoint, {
    headers: { "User-Agent": "Mozilla/5.0 (TFEmby Web poster lookup)" },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) return undefined;
  const html = await response.text();
  const marker = "window.__DATA__ =";
  const start = html.indexOf(marker);
  const end = html.indexOf("window.__USER__", start + marker.length);
  if (start < 0 || end < 0) return undefined;
  const json = html.slice(start + marker.length, end).trim().replace(/;$/, "").trim();
  return choosePoster(searchRows(JSON.parse(json)), item);
}

export async function findDoubanPoster(item: ChartItem): Promise<string | undefined> {
  const key = `${item.mediaType}:${item.title}:${item.year || ""}`;
  const cached = posterCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let poster: string | undefined;
  try {
    poster = await customDoubanSearch(item);
  } catch {
    poster = undefined;
  }
  if (!poster) {
    try {
      poster = await publicDoubanSearch(item);
    } catch {
      poster = undefined;
    }
  }
  if (!poster) {
    try {
      poster = await publicDoubanHtmlSearch(item);
    } catch {
      poster = undefined;
    }
  }
  posterCache.set(key, { value: poster, expiresAt: Date.now() + (poster ? 12 * 60 * 60 * 1000 : 30 * 60 * 1000) });
  return poster;
}

export async function fetchDoubanChart(chart: string, media = "all", period = "week", page = 1, year?: number, genre?: number): Promise<ChartPage> {
  const currentPage = Math.min(30, Math.max(1, page));
  if (!config.doubanApiBase) return fallback(chart, media, currentPage, year);

  const endpoint = new URL(config.doubanApiBase.replace(/\/+$/, "") + "/charts");
  endpoint.searchParams.set("chart", chart);
  endpoint.searchParams.set("media", media);
  endpoint.searchParams.set("period", period);
  endpoint.searchParams.set("page", String(currentPage));
  if (year) endpoint.searchParams.set("year", String(year));
  if (genre) endpoint.searchParams.set("genre", String(genre));

  try {
    const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
    if (!response.ok) return fallback(chart, media, currentPage, year);
    const data = (await response.json()) as { items?: Partial<ChartItem>[]; page?: number; totalPages?: number; total_pages?: number; totalResults?: number; total_results?: number };
    const items: ChartItem[] = (data.items || []).slice(0, 20).map((item, index) => ({
      source: "douban",
      chart,
      rank: (currentPage - 1) * 20 + index + 1,
      title: item.title || "未命名",
      originalTitle: item.originalTitle,
      mediaType: item.mediaType === "tv" ? "tv" : "movie",
      year: item.year,
      poster: item.poster,
      backdrop: item.backdrop,
      overview: item.overview,
      voteAverage: item.voteAverage,
      releaseDate: item.releaseDate,
      externalIds: {
        douban: item.externalIds?.douban,
        tmdb: item.externalIds?.tmdb,
        imdb: item.externalIds?.imdb
      }
    }));
    return {
      items,
      page: currentPage,
      totalPages: Math.min(30, Math.max(1, data.totalPages || data.total_pages || 1)),
      totalResults: data.totalResults || data.total_results || items.length
    };
  } catch {
    return fallback(chart, media, currentPage, year);
  }
}
