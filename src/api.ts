import type { AdminSettings, AppConfig, ChartItem, EmbySession, MediaItem, MediaRequest, RequestStatus, TelegramIntegration, TvSeason, UserSession } from "./types";

const sessionKey = "tfemby-web-session";

export function loadSession(): UserSession | null {
  const raw = localStorage.getItem(sessionKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as UserSession | EmbySession;
    if ("token" in parsed) return parsed;
    if ("accessToken" in parsed) {
      return {
        token: "",
        userId: parsed.userId,
        username: parsed.userName,
        role: parsed.isAdmin ? "admin" : "user",
        emby: parsed
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveSession(session: UserSession | null) {
  if (!session) localStorage.removeItem(sessionKey);
  else localStorage.setItem(sessionKey, JSON.stringify(session));
}

async function request<T>(path: string, session?: UserSession | EmbySession | null, init?: RequestInit): Promise<T> {
  const appSession = session && "token" in session ? session : null;
  const embySession = session && "accessToken" in session ? session : appSession?.emby;
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(appSession?.token ? { Authorization: `Bearer ${appSession.token}` } : {}),
      ...(embySession
        ? {
            "x-emby-token": embySession.accessToken,
            "x-emby-user-id": embySession.userId,
            "x-emby-user-name": embySession.userName,
            "x-emby-server-url": embySession.serverUrl
          }
        : {}),
      ...(init?.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error || response.statusText);
  }
  return data as T;
}

export const api = {
  config: () => request<AppConfig>("/api/config"),
  setup: (username: string, password: string) =>
    request<UserSession>("/api/auth/setup", null, {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  login: (username: string, password: string) =>
    request<UserSession>("/api/auth/login", null, {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  linkEmby: (session: UserSession, username: string, password: string) =>
    request<UserSession>("/api/auth/link-emby", session, {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  stats: (session: EmbySession) =>
    request<{ movies: number; series: number; played: number; resume: number; latest: number }>("/api/emby/stats", session),
  search: (session: EmbySession, query: string) =>
    request<MediaItem[]>(`/api/emby/search?q=${encodeURIComponent(query)}`, session),
  resume: (session: EmbySession) => request<MediaItem[]>("/api/emby/resume", session),
  history: (session: EmbySession) => request<MediaItem[]>("/api/emby/history", session),
  latest: (session: EmbySession) => request<MediaItem[]>("/api/emby/latest", session),
  chart: (source: string, chart: string, media: string, period: string, session?: EmbySession | null) =>
    request<ChartItem[]>(`/api/charts/${source}/${chart}?media=${media}&period=${period}`, session),
  searchTmdb: (session: UserSession, query: string) =>
    request<ChartItem[]>(`/api/tmdb/search?q=${encodeURIComponent(query)}`, session),
  tvSeasons: (session: UserSession, tmdbId: string) =>
    request<TvSeason[]>(`/api/tmdb/tv/${encodeURIComponent(tmdbId)}/seasons`, session),
  requests: (session: UserSession) => request<MediaRequest[]>("/api/requests", session),
  createRequest: (session: UserSession, tmdbId: string, mediaType: "movie" | "tv", seasonNumber?: number) =>
    request<MediaRequest>("/api/requests", session, {
      method: "POST",
      body: JSON.stringify({ tmdbId, mediaType, seasonNumber })
    }),
  updateRequest: (session: UserSession, id: string, status: RequestStatus) =>
    request<MediaRequest>(`/api/requests/${encodeURIComponent(id)}`, session, {
      method: "PATCH",
      body: JSON.stringify({ status })
    }),
  adminSettings: (session: UserSession) => request<AdminSettings>("/api/admin/settings", session),
  saveAdminSettings: (session: UserSession, settings: AdminSettings) =>
    request<AdminSettings>("/api/admin/settings", session, {
      method: "PUT",
      body: JSON.stringify({ web: settings.web, bot: settings.bot })
    }),
  testAdminSetting: (session: UserSession, target: "emby" | "tmdb" | "douban" | "telegram" | "all") =>
    request<{ messages?: string[] }>(`/api/admin/settings/test/${target}`, session, { method: "POST" }),
  telegramStatus: (session: UserSession) => request<TelegramIntegration>("/api/integrations/telegram", session),
  telegramTest: (session: UserSession) => request<{ configured: boolean; sent: number }>("/api/integrations/telegram/test", session, { method: "POST" }),
  telegramAction: (session: UserSession, action: "start" | "stop" | "scan") =>
    request<Record<string, unknown>>(`/api/integrations/telegram/${action}`, session, { method: "POST" })
};
