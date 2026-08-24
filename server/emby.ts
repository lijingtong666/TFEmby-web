import { cleanBaseUrl, config } from "./config.js";
import type { ChartItem, EmbySession, MediaItem } from "./types.js";
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
    throw new Error(text || `${response.status} ${response.statusText}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function embyFetch<T>(session: EmbySession, path: string, init?: RequestInit) {
  const serverUrl = normalizeServer(session.serverUrl);
  const separator = path.includes("?") ? "&" : "?";
  const url = `${serverUrl}${path}${separator}api_key=${encodeURIComponent(session.accessToken)}`;
  const response = await fetch(url, {
    ...init,
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
  const userName = headerValue(headers, "x-emby-user-name") || "Emby";
  if (!accessToken || !userId || !serverUrl) return null;
  return {
    accessToken,
    userId,
    serverUrl: cleanBaseUrl(serverUrl),
    userName
  };
}

function imageUrl(session: EmbySession, item: EmbyItem, kind: "Primary" | "Backdrop") {
  const hasImage = kind === "Primary" ? item.ImageTags?.Primary : item.BackdropImageTags?.[0];
  if (!hasImage) return undefined;
  const base = `${normalizeServer(session.serverUrl)}/Items/${item.Id}/Images/${kind}`;
  const params = new URLSearchParams({
    maxWidth: kind === "Primary" ? "500" : "1200",
    quality: "90",
    api_key: session.accessToken
  });
  return `${base}?${params.toString()}`;
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

function toMediaItem(session: EmbySession, item: EmbyItem): MediaItem {
  return {
    id: item.Id,
    title: item.Name,
    originalTitle: item.OriginalTitle,
    type: kind(item.Type),
    year: item.ProductionYear,
    overview: item.Overview,
    poster: imageUrl(session, item, "Primary"),
    backdrop: imageUrl(session, item, "Backdrop"),
    dateCreated: item.DateCreated,
    premiereDate: item.PremiereDate,
    communityRating: item.CommunityRating,
    criticRating: item.CriticRating,
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
  "BackdropImageTags"
].join(",");

export async function searchLibrary(session: EmbySession, query: string, limit = 48) {
  const params = new URLSearchParams({
    UserId: session.userId,
    SearchTerm: query,
    Recursive: "true",
    IncludeItemTypes: "Movie,Series,Episode",
    Fields: fields,
    Limit: String(limit)
  });
  const data = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items?${params.toString()}`);
  return (data.Items || []).map((item) => toMediaItem(session, item));
}

export async function getResumeItems(session: EmbySession, limit = 30) {
  const params = new URLSearchParams({
    UserId: session.userId,
    IncludeItemTypes: "Movie,Episode",
    Fields: fields,
    Limit: String(limit)
  });
  const data = await embyFetch<EmbyItemsResponse>(session, `/Users/${session.userId}/Items/Resume?${params.toString()}`);
  return (data.Items || []).map((item) => toMediaItem(session, item));
}

export async function getLatestItems(session: EmbySession, limit = 36) {
  const params = new URLSearchParams({
    IncludeItemTypes: "Movie,Series,Episode",
    Fields: fields,
    Limit: String(limit)
  });
  const data = await embyFetch<EmbyItem[]>(session, `/Users/${session.userId}/Items/Latest?${params.toString()}`);
  return (data || []).map((item) => toMediaItem(session, item));
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
  return (data.Items || []).map((item) => toMediaItem(session, item));
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

  const [movies, series, played, resume, latest] = await Promise.all([
    queryCount("Movie"),
    queryCount("Series"),
    queryCount("Movie,Series,Episode", { Filters: "IsPlayed" }),
    queryCount("Movie,Episode", { Filters: "IsResumable" }),
    getLatestItems(session, 1)
  ]);

  return {
    movies,
    series,
    played,
    resume,
    latest: latest.length
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
