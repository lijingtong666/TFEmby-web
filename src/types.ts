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
  backdrop?: string;
  dateCreated?: string;
  premiereDate?: string;
  communityRating?: number;
  criticRating?: number;
  providerIds: Record<string, string>;
  userData?: {
    played?: boolean;
    playCount?: number;
    lastPlayedDate?: string;
    progressPercent?: number;
  };
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

export type AppConfig = {
  appName: string;
  version: string;
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
  doubanApiBase: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramApiBase: string;
  tgBotUrl: string;
  publicTgBotUrl: string;
  tgBotPort: number;
};

export type TgBotConfig = {
  telegramBotToken: string;
  telegramChatId: string;
  tmdbApiKey: string;
  tmdbLanguage: string;
  embyUrl: string;
  embyApiKey: string;
  embyUserId: string;
  publicBaseUrl: string;
  webhookSecret: string;
  doubanFallbackEnabled: boolean;
  enableCovers: boolean;
  overviewMaxLength: number;
  monitoredEvents: string;
  includeTypes: string[];
  pollIntervalSeconds: number;
  latestLimit: number;
  notifyFirstRun: boolean;
  proxyEnabled: boolean;
  proxyUrl: string;
};

export type AdminSettings = {
  web: WebSettings;
  bot: TgBotConfig | null;
  sidecarReachable: boolean;
  warning?: string;
};

export type TelegramIntegration = {
  directConfigured: boolean;
  sidecarReachable: boolean;
  manageUrl: string;
  port: number;
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
  } | null;
};

export type RequestStatus = "pending" | "approved" | "fulfilled" | "rejected";

export type MediaRequest = {
  id: string;
  tmdbId: string;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle?: string;
  year?: number;
  poster?: string;
  overview?: string;
  requestedBy: {
    userId: string;
    username: string;
  };
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
};
