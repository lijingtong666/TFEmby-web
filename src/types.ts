export type EmbySession = {
  serverUrl: string;
  userId: string;
  accessToken: string;
  userName: string;
  isAdmin?: boolean;
};

export type UserSession = {
  token: string;
  userId: string;
  username: string;
  role: "admin" | "user";
  emby?: EmbySession;
};

export type MediaItem = {
  id: string;
  title: string;
  originalTitle?: string;
  type: "movie" | "series" | "episode" | "tv" | "all";
  year?: number;
  overview?: string;
  poster?: string;
  posterFallback?: string;
  backdrop?: string;
  dateCreated?: string;
  premiereDate?: string;
  communityRating?: number;
  criticRating?: number;
  seriesId?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  recentEpisodeRange?: string;
  recentEpisodeCount?: number;
  providerIds: Record<string, string>;
  userData?: {
    played?: boolean;
    playCount?: number;
    lastPlayedDate?: string;
    progressPercent?: number;
  };
};

export type LibrarySeasonStatus = {
  id?: string;
  name: string;
  seasonNumber: number;
  episodeCount: number;
  playedEpisodeCount: number;
  played: boolean;
  poster?: string;
};

export type LibraryMediaDetails = {
  item: MediaItem;
  seasons: LibrarySeasonStatus[];
  totalSeasons: number;
  totalEpisodes: number;
  playedEpisodes: number;
};

export type TvSeason = {
  seasonNumber: number;
  name: string;
  episodeCount?: number;
  airDate?: string;
  poster?: string;
  inLibrary: boolean;
};

export type TvEpisode = {
  episodeNumber: number;
  name: string;
  overview?: string;
  airDate?: string;
  runtime?: number;
  still?: string;
};

export type TvSeasonDetail = TvSeason & {
  overview?: string;
  episodes: TvEpisode[];
};

export type ChartItem = {
  source: "tmdb" | "douban" | "demo";
  chart: string;
  rank: number;
  title: string;
  originalTitle?: string;
  mediaType: "movie" | "tv";
  year?: number;
  poster?: string;
  backdrop?: string;
  overview?: string;
  voteAverage?: number;
  releaseDate?: string;
  totalSeasons?: number;
  totalEpisodes?: number;
  externalIds: {
    tmdb?: string;
    imdb?: string;
    douban?: string;
  };
  libraryStatus?: {
    inLibrary: boolean;
    watched: boolean;
    progressPercent?: number;
    embyId?: string;
    lastPlayedDate?: string;
  };
};

export type ChartPage = {
  items: ChartItem[];
  page: number;
  totalPages: number;
  totalResults: number;
};

export type TmdbTitleDetails = {
  item: ChartItem;
  seasons: TvSeason[];
};

export type AppConfig = {
  appName: string;
  version: string;
  timeZone: string;
  embyServerUrl: string;
  tmdbEnabled: boolean;
  doubanEnabled: boolean;
  telegramEnabled: boolean;
  requiresSetup: boolean;
};

export type WebSettings = {
  appName: string;
  embyServerUrl: string;
  tmdbApiKey: string;
  tmdbBearerToken: string;
  tmdbApiBases: string;
  tmdbImageBases: string;
  doubanApiBase: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramApiBase: string;
  proxyEnabled: boolean;
  proxyUrl: string;
};

export type TgBotConfig = {
  telegramBotToken: string;
  telegramChatId: string;
  telegramMenuUserIds: string;
  tmdbApiKey: string;
  tmdbLanguage: string;
  embyUrl: string;
  embyApiKey: string;
  embyUserId: string;
  webhookSecret: string;
  doubanFallbackEnabled: boolean;
  enableCovers: boolean;
  overviewMaxLength: number;
  monitoredEvents: string;
  includeTypes: string[];
  pollIntervalSeconds: number;
  latestLimit: number;
  notifyFirstRun: boolean;
  notifyPlayback: boolean;
};

export type AdminSettings = {
  web: WebSettings;
  bot: TgBotConfig | null;
  notificationReady: boolean;
  warning?: string;
};

export type TelegramIntegration = {
  directConfigured: boolean;
  serviceReady: boolean;
  status: {
    version?: string;
    running?: boolean;
    telegramRunning?: boolean;
    lastTickAt?: string | null;
    lastScanAt?: string | null;
    lastWebhookAt?: string | null;
    lastError?: string;
    lastSummary?: string;
    seenCount?: number;
    menuReady?: boolean;
    lastMenuAt?: string | null;
    lastMenuError?: string;
  } | null;
};

export type LatencyStatus = {
  checkedAt: string;
  results: Array<{
    target: "tmdb" | "telegram" | "proxy";
    label: string;
    ok: boolean;
    latencyMs: number | null;
    status: string;
    viaProxy: boolean;
  }>;
};

export type RequestStatus = "pending" | "approved" | "fulfilled" | "rejected";

export type TelegramMessageReference = {
  chatId: string;
  messageId: number;
};

export type MediaRequest = {
  id: string;
  tmdbId: string;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle?: string;
  year?: number;
  poster?: string;
  overview?: string;
  seasonNumber?: number;
  seasonName?: string;
  expectedEpisodeCount?: number;
  requestedBy: {
    userId: string;
    username: string;
  };
  status: RequestStatus;
  statusUpdatedBy?: string;
  fulfilledAt?: string;
  telegramMessages?: TelegramMessageReference[];
  createdAt: string;
  updatedAt: string;
};
