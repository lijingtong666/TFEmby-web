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
    playbackPositionTicks?: number;
    runtimeTicks?: number;
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
