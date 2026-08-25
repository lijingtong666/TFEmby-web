export type MediaKind = "movie" | "series" | "episode" | "tv" | "all";

export type EmbySession = {
  serverUrl: string;
  userId: string;
  accessToken: string;
  userName: string;
  isAdmin?: boolean;
};

export type MediaItem = {
  id: string;
  title: string;
  originalTitle?: string;
  type: MediaKind;
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
    playbackPositionTicks?: number;
    runtimeTicks?: number;
    progressPercent?: number;
  };
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
