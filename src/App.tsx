import {
  BadgePlus,
  BarChart3,
  BellRing,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  ClipboardList,
  Compass,
  Copy,
  Flame,
  ExternalLink,
  Eye,
  EyeOff,
  Gauge,
  Library,
  Layers3,
  Link2,
  LogIn,
  LogOut,
  Menu,
  Moon,
  PlaySquare,
  RefreshCw,
  Search,
  Send,
  Save,
  Settings,
  ShieldCheck,
  Star,
  Sun,
  TestTube2,
  Tv,
  Webhook,
  X
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { api, loadSession, saveSession } from "./api";
import type { AdminSettings, AppConfig, ChartItem, ChartPage, EmbySession, LatencyStatus, LibraryMediaDetails, MediaItem, MediaRequest, RequestStatus, TelegramIntegration, TgBotConfig, TmdbTitleDetails, TvSeason, TvSeasonDetail, UserSession, WebSettings } from "./types";

type View = "overview" | "charts" | "discover" | "search" | "resume" | "latest" | "requests" | "admin";

const navItems: { key: View; label: string; icon: ReactNode; adminOnly?: boolean }[] = [
  { key: "overview", label: "总览概况", icon: <BarChart3 size={22} /> },
  { key: "charts", label: "全网热榜", icon: <Flame size={22} /> },
  { key: "discover", label: "探索发现", icon: <Compass size={22} /> },
  { key: "search", label: "片库搜索", icon: <Search size={22} /> },
  { key: "resume", label: "继续观看", icon: <PlaySquare size={22} /> },
  { key: "latest", label: "最近新增", icon: <BadgePlus size={22} /> },
  { key: "requests", label: "求片申请", icon: <ClipboardList size={22} /> },
  { key: "admin", label: "管理后台", icon: <Settings size={22} />, adminOnly: true }
];

const requestStatus: Record<RequestStatus, string> = {
  pending: "待处理",
  approved: "已接受",
  fulfilled: "已入库",
  rejected: "已拒绝"
};

const minimumVisibleScore = 5;
const visibleChartItems = (items: ChartItem[]) => items.filter((item) => typeof item.voteAverage === "number" && item.voteAverage >= minimumVisibleScore);

type ChartSection = {
  id: string;
  label: string;
  source: "tmdb" | "douban";
  chart: string;
  media: "all" | "movie" | "tv";
  period: "day" | "week" | "month" | "all";
  genre?: string;
};

type ChartTab = "all" | "movies" | "tv" | "animation" | "rankings";

const chartSections = {
  global: { id: "global", label: "全球流行趋势", source: "tmdb", chart: "global", media: "all", period: "week" },
  nowPlaying: { id: "now-playing", label: "正在热映", source: "tmdb", chart: "now-playing", media: "movie", period: "week" },
  moviePopular: { id: "movie-popular", label: "TMDB 热门电影", source: "tmdb", chart: "movie-popular", media: "movie", period: "week" },
  tvPopular: { id: "tv-popular", label: "TMDB 热门电视剧", source: "tmdb", chart: "tv-popular", media: "tv", period: "week" },
  movieTop: { id: "movie-top", label: "TMDB 高分电影", source: "tmdb", chart: "movie-top-rated", media: "movie", period: "week" },
  tvTop: { id: "tv-top", label: "TMDB 高分电视剧", source: "tmdb", chart: "tv-top-rated", media: "tv", period: "week" },
  movieMonthly: { id: "movie-monthly", label: "TMDB 电影月榜", source: "tmdb", chart: "monthly", media: "movie", period: "month" },
  tvMonthly: { id: "tv-monthly", label: "TMDB 剧集月榜", source: "tmdb", chart: "monthly", media: "tv", period: "month" },
  doubanMovieWeekly: { id: "douban-movie-weekly", label: "豆瓣电影周榜", source: "douban", chart: "weekly", media: "movie", period: "week" },
  doubanTvWeekly: { id: "douban-tv-weekly", label: "豆瓣剧集周榜", source: "douban", chart: "weekly", media: "tv", period: "week" },
  doubanMovieMonthly: { id: "douban-movie-monthly", label: "豆瓣电影月榜", source: "douban", chart: "monthly", media: "movie", period: "month" },
  doubanTvMonthly: { id: "douban-tv-monthly", label: "豆瓣剧集月榜", source: "douban", chart: "monthly", media: "tv", period: "month" },
  doubanTop250: { id: "douban-top250", label: "豆瓣电影 TOP250", source: "douban", chart: "top250", media: "movie", period: "all" },
  animationMovies: { id: "animation-movies", label: "TMDB 热门动画电影", source: "tmdb", chart: "movie-popular", media: "movie", period: "week", genre: "16" },
  animationMovieTop: { id: "animation-movie-top", label: "TMDB 高分动画电影", source: "tmdb", chart: "movie-top-rated", media: "movie", period: "week", genre: "16" },
  animationTv: { id: "animation-tv", label: "TMDB 热门动画剧集", source: "tmdb", chart: "tv-popular", media: "tv", period: "week", genre: "16" },
  animationTvTop: { id: "animation-tv-top", label: "TMDB 高分动画剧集", source: "tmdb", chart: "tv-top-rated", media: "tv", period: "week", genre: "16" }
} satisfies Record<string, ChartSection>;

const chartTabs: Array<{ key: ChartTab; label: string; icon: ReactNode; sections: ChartSection[] }> = [
  {
    key: "all",
    label: "全部",
    icon: <Library size={19} />,
    sections: [chartSections.global, chartSections.nowPlaying, chartSections.moviePopular, chartSections.tvPopular, chartSections.doubanTop250]
  },
  {
    key: "movies",
    label: "电影",
    icon: <Clapperboard size={19} />,
    sections: [chartSections.nowPlaying, chartSections.moviePopular, chartSections.movieTop, chartSections.movieMonthly, chartSections.doubanMovieWeekly, chartSections.doubanMovieMonthly, chartSections.doubanTop250]
  },
  {
    key: "tv",
    label: "电视剧",
    icon: <Tv size={19} />,
    sections: [chartSections.tvPopular, chartSections.tvTop, chartSections.tvMonthly, chartSections.doubanTvWeekly, chartSections.doubanTvMonthly]
  },
  {
    key: "animation",
    label: "动画",
    icon: <Layers3 size={19} />,
    sections: [chartSections.animationMovies, chartSections.animationMovieTop, chartSections.animationTv, chartSections.animationTvTop]
  },
  {
    key: "rankings",
    label: "榜单",
    icon: <Star size={19} />,
    sections: [chartSections.global, chartSections.movieTop, chartSections.tvTop, chartSections.doubanTop250]
  }
];

const movieGenres = [
  [28, "动作"], [12, "冒险"], [16, "动画"], [35, "喜剧"], [80, "犯罪"], [99, "纪录片"],
  [18, "剧情"], [10751, "家庭"], [14, "奇幻"], [36, "历史"], [27, "恐怖"], [10402, "音乐"],
  [9648, "悬疑"], [10749, "爱情"], [878, "科幻"], [53, "惊悚"], [10752, "战争"], [37, "西部"]
] as const;

const tvGenres = [
  [10759, "动作冒险"], [16, "动画"], [35, "喜剧"], [80, "犯罪"], [99, "纪录片"], [18, "剧情"],
  [10751, "家庭"], [10762, "儿童"], [9648, "悬疑"], [10764, "真人秀"], [10765, "科幻奇幻"],
  [10766, "肥皂剧"], [10767, "脱口秀"], [10768, "战争政治"], [37, "西部"]
] as const;

const discoverSorts = [
  ["popular-desc", "热度降序"],
  ["popular-asc", "热度升序"],
  ["score-desc", "评分优先"],
  ["release-desc", "最新上映"],
  ["release-asc", "最早上映"]
] as const;

const discoverLanguages = [
  ["", "全部语言"],
  ["zh", "中文"],
  ["en", "英语"],
  ["ja", "日语"],
  ["ko", "韩语"],
  ["fr", "法语"],
  ["de", "德语"],
  ["es", "西班牙语"]
] as const;

const emptyChartPage: ChartPage = { items: [], page: 1, totalPages: 1, totalResults: 0 };

function pageNumbers(current: number, total: number) {
  const values = new Set([1, total, current - 1, current, current + 1]);
  return [...values].filter((value) => value >= 1 && value <= total).sort((left, right) => left - right);
}

function useAsync<T>(loader: () => Promise<T>, deps: unknown[], initial: T) {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    loader()
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, deps);

  return { data, loading, error, reload: () => loader().then(setData) };
}

function formatDate(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function Poster({ item, compact = false }: { item: MediaItem | ChartItem | MediaRequest; compact?: boolean }) {
  const title = "title" in item ? item.title : "";
  const posterFallback = "posterFallback" in item ? item.posterFallback : undefined;
  const backdrop = "backdrop" in item ? item.backdrop : undefined;
  const sources = [
    item.poster,
    posterFallback,
    backdrop
  ].filter((value): value is string => Boolean(value));
  const [sourceIndex, setSourceIndex] = useState(0);
  const [resolvedSource, setResolvedSource] = useState<string>();
  useEffect(() => setSourceIndex(0), [item.poster, posterFallback, backdrop]);
  const source = sources[sourceIndex];
  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    setResolvedSource(undefined);
    if (!source) return;
    if (!source.startsWith("/api/emby/")) {
      setResolvedSource(source);
      return;
    }
    api.mediaImage(source)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setResolvedSource(objectUrl);
      })
      .catch(() => alive && setSourceIndex((current) => current + 1));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source]);
  return (
    <div className={`poster ${compact ? "posterCompact" : ""}`}>
      {resolvedSource ? <img src={resolvedSource} alt={title} loading="lazy" onError={() => setSourceIndex((current) => current + 1)} /> : <div className="posterFallback">{title.slice(0, 4)}</div>}
    </div>
  );
}

function ChartCard({ item, onOpen, showRank = true }: { item: ChartItem; onOpen: () => void; showRank?: boolean }) {
  const status = item.libraryStatus;
  return (
    <article
      className="mediaCard chartCard"
      role="button"
      tabIndex={0}
      aria-label={`查看《${item.title}》详情`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {showRank ? <div className="rank">#{item.rank}</div> : null}
      <Poster item={item} />
      <div className="mediaTitle" title={item.title}>
        {item.title}
      </div>
      <div className="metaLine">
        <Star size={15} fill="currentColor" />
        <span>{item.voteAverage ? item.voteAverage.toFixed(1) : "N/A"}</span>
        <span>·</span>
        <span>{item.year || "未知"}</span>
      </div>
      {status?.inLibrary && (
        <div className={`watchBadge ${status.watched ? "watched" : ""}`}>
          <CheckCircle2 size={14} />
          {status.watched ? "已看" : status.progressPercent ? `${status.progressPercent}%` : "已入库"}
        </div>
      )}
    </article>
  );
}

function ShelfCard({ item, onOpen }: { item: ChartItem; onOpen: () => void }) {
  const status = item.libraryStatus;
  return (
    <article
      className="shelfCard"
      role="button"
      tabIndex={0}
      aria-label={`查看《${item.title}》详情`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="shelfPoster">
        <Poster item={item} />
        <span className="shelfMediaType">{item.mediaType === "tv" ? "电视剧" : "电影"}</span>
        <span className="shelfScore"><Star size={12} fill="currentColor" />{item.voteAverage ? item.voteAverage.toFixed(1) : "N/A"}</span>
        {status?.inLibrary ? (
          <span className={`shelfLibraryState ${status.watched ? "watched" : ""}`}>
            <CheckCircle2 size={12} />{status.watched ? "已看" : "已入库"}
          </span>
        ) : null}
      </div>
      <strong title={item.title}>{item.title}</strong>
      <span>{item.year || "年份未知"} · #{item.rank}</span>
    </article>
  );
}

function ChartShelf({ section, session, onMore, onOpen }: { section: ChartSection; session: EmbySession | null; onMore: () => void; onOpen: (item: ChartItem) => void }) {
  const { data, loading, error } = useAsync(
    () => api.chart(section.source, section.chart, section.media, section.period, 1, "", section.genre || "", session),
    [section.source, section.chart, section.media, section.period, section.genre, session?.accessToken],
    emptyChartPage
  );
  const items = visibleChartItems(data.items);

  return (
    <section className="chartShelf">
      <div className="shelfHead">
        <h2>{section.label}</h2>
        <button type="button" onClick={onMore}>更多<ChevronRight size={17} /></button>
      </div>
      {error ? <div className="shelfNotice">{error}</div> : null}
      {loading ? (
        <div className="shelfTrack shelfLoading" aria-label={`${section.label}加载中`}>
          {Array.from({ length: 10 }, (_, index) => <div className="shelfSkeleton" key={index} />)}
        </div>
      ) : items.length ? (
        <div className="shelfTrack">
          {items.map((item) => (
            <ShelfCard key={`${item.source}-${item.externalIds.tmdb || item.externalIds.douban || item.rank}-${item.title}`} item={item} onOpen={() => onOpen(item)} />
          ))}
        </div>
      ) : !error ? <div className="shelfNotice">当前榜单暂无内容。</div> : null}
    </section>
  );
}

function ChartDetail({ item, session, onClose }: { item: ChartItem | null; session: EmbySession | null; onClose: () => void }) {
  const [details, setDetails] = useState<TmdbTitleDetails | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [seasonDetail, setSeasonDetail] = useState<TvSeasonDetail | null>(null);
  const [seasonLoading, setSeasonLoading] = useState(false);

  useEffect(() => {
    if (!item) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [item, onClose]);

  useEffect(() => {
    const tmdbId = item?.externalIds.tmdb;
    setDetails(null);
    setDetailsError("");
    setSelectedSeason(null);
    setSeasonDetail(null);
    setDetailsLoading(false);
    if (!item || !tmdbId || !/^\d+$/.test(tmdbId)) return;
    let alive = true;
    setDetailsLoading(true);
    api.tmdbDetails(tmdbId, item.mediaType, session)
      .then((value) => {
        if (!alive) return;
        setDetails(value);
        setSelectedSeason(value.seasons[0]?.seasonNumber || null);
      })
      .catch((error: Error) => alive && setDetailsError(error.message))
      .finally(() => alive && setDetailsLoading(false));
    return () => { alive = false; };
  }, [item, session?.accessToken]);

  useEffect(() => {
    const tmdbId = item?.externalIds.tmdb;
    setSeasonDetail(null);
    setSeasonLoading(false);
    if (!tmdbId || !selectedSeason) return;
    let alive = true;
    setDetailsError("");
    setSeasonLoading(true);
    api.tmdbSeason(tmdbId, selectedSeason, session)
      .then((value) => alive && setSeasonDetail(value))
      .catch((error: Error) => alive && setDetailsError(error.message))
      .finally(() => alive && setSeasonLoading(false));
    return () => { alive = false; };
  }, [item?.externalIds.tmdb, selectedSeason, session?.accessToken]);

  if (!item) return null;
  const resolvedItem: ChartItem = details?.item
    ? { ...item, ...details.item, source: item.source, chart: item.chart, rank: item.rank, libraryStatus: details.item.libraryStatus || item.libraryStatus }
    : item;
  const status = resolvedItem.libraryStatus;
  const tmdbId = resolvedItem.externalIds.tmdb;
  const doubanId = resolvedItem.externalIds.douban;
  const tmdbUrl = tmdbId && /^\d+$/.test(tmdbId) ? `https://www.themoviedb.org/${resolvedItem.mediaType}/${tmdbId}` : "";
  const doubanUrl = doubanId && /^\d+$/.test(doubanId) ? `https://movie.douban.com/subject/${doubanId}/` : "";
  const seasons = details?.seasons || [];
  const activeSeason = seasonDetail?.seasonNumber === selectedSeason ? seasonDetail : seasons.find((season) => season.seasonNumber === selectedSeason);
  const totalSeasons = resolvedItem.totalSeasons || seasons.length;
  const totalEpisodes = resolvedItem.totalEpisodes || seasons.reduce((total, season) => total + (season.episodeCount || 0), 0);

  return (
    <div className="detailOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="detailModal" role="dialog" aria-modal="true" aria-label={`${resolvedItem.title}详情`}>
        <button className="detailClose" onClick={onClose} title="关闭详情" aria-label="关闭详情"><X size={21} /></button>
        <div className="detailVisual">
          {resolvedItem.backdrop || resolvedItem.poster ? <img className="detailBackdrop" src={resolvedItem.backdrop || resolvedItem.poster} alt="" /> : <div className="detailBackdrop detailBackdropFallback" />}
          <div className="detailShade" />
          <div className="detailHeading">
            <div className="detailPoster"><Poster item={resolvedItem} /></div>
            <div className="detailTitleBlock">
              <div className="detailBadges">
                <span>{resolvedItem.mediaType === "tv" ? "剧集" : "电影"}</span>
                <span>{resolvedItem.source === "tmdb" ? "TMDB" : resolvedItem.source === "douban" ? "豆瓣" : "热榜"}</span>
                {status?.inLibrary ? <span className="inLibraryBadge"><CheckCircle2 size={13} />已入库</span> : null}
              </div>
              <h1>{resolvedItem.title}</h1>
              {resolvedItem.originalTitle && resolvedItem.originalTitle !== resolvedItem.title ? <p>{resolvedItem.originalTitle}</p> : null}
            </div>
          </div>
        </div>
        <div className="detailContent">
          {detailsLoading ? <div className="detailLoading">正在读取完整资料。</div> : null}
          {detailsError ? <div className="notice">{detailsError}</div> : null}
          <div className="detailFacts">
            <div><span>评分</span><strong><Star size={16} fill="currentColor" />{resolvedItem.voteAverage ? resolvedItem.voteAverage.toFixed(1) : "暂无"}</strong></div>
            <div><span>年份</span><strong>{resolvedItem.year || "未知"}</strong></div>
            <div><span>{resolvedItem.mediaType === "tv" ? "首播日期" : "上映日期"}</span><strong>{resolvedItem.releaseDate || "未知"}</strong></div>
            {resolvedItem.mediaType === "tv" ? <div><span>总季数</span><strong>{totalSeasons ? `${totalSeasons} 季` : "未知"}</strong></div> : null}
            {resolvedItem.mediaType === "tv" ? <div><span>总集数</span><strong>{totalEpisodes ? `${totalEpisodes} 集` : "未知"}</strong></div> : null}
            <div><span>入库状态</span><strong>{status?.inLibrary ? "已入库" : "未入库"}</strong></div>
          </div>
          <div className="detailOverview">
            <h2>简介</h2>
            <p>{resolvedItem.overview || "暂无简介。"}</p>
          </div>
          {resolvedItem.mediaType === "tv" && seasons.length ? (
            <div className="detailSeasons">
              <div className="detailSectionTitle"><h2>季度与剧集</h2><span>共 {totalSeasons || seasons.length} 季 · {totalEpisodes || "未知"} 集</span></div>
              <div className="detailSeasonTabs" role="tablist" aria-label="选择季度">
                {seasons.map((season) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selectedSeason === season.seasonNumber}
                    className={selectedSeason === season.seasonNumber ? "active" : ""}
                    key={season.seasonNumber}
                    onClick={() => setSelectedSeason(season.seasonNumber)}
                  >
                    第 {season.seasonNumber} 季
                    {season.inLibrary ? <CheckCircle2 size={13} /> : null}
                  </button>
                ))}
              </div>
              {seasonLoading ? <div className="detailLoading">正在读取第 {selectedSeason} 季。</div> : null}
              {activeSeason ? (
                <div className={`detailSeasonPanel ${activeSeason.poster ? "" : "noPoster"}`}>
                  {activeSeason.poster ? <img src={activeSeason.poster} alt={activeSeason.name} /> : null}
                  <div className="detailSeasonBody">
                    <div className="detailSeasonHead">
                      <div><strong>{activeSeason.name}</strong><span>{activeSeason.episodeCount ? `${activeSeason.episodeCount} 集` : "集数未知"}{activeSeason.airDate ? ` · ${activeSeason.airDate}` : ""}</span></div>
                      {activeSeason.inLibrary ? <span className="seasonLibraryState"><CheckCircle2 size={14} />库中存在</span> : null}
                    </div>
                    {seasonDetail?.seasonNumber === selectedSeason && seasonDetail.overview ? <p>{seasonDetail.overview}</p> : null}
                    {seasonDetail?.episodes.length ? (
                      <div className="detailEpisodeList">
                        {seasonDetail.episodes.map((episode) => (
                          <div className="detailEpisode" key={episode.episodeNumber}>
                            {episode.still ? <img src={episode.still} alt="" loading="lazy" /> : <div className="episodeStillFallback">E{episode.episodeNumber}</div>}
                            <div>
                              <strong>第 {episode.episodeNumber} 集 · {episode.name}</strong>
                              <span>{episode.airDate || "日期未知"}{episode.runtime ? ` · ${episode.runtime} 分钟` : ""}</span>
                              {episode.overview ? <p>{episode.overview}</p> : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="detailFooter">
            <div className="detailIds">
              {tmdbId ? <span>TMDB ID {tmdbId}</span> : null}
              {doubanId ? <span>豆瓣 ID {doubanId}</span> : null}
              {resolvedItem.externalIds.imdb ? <span>IMDb {resolvedItem.externalIds.imdb}</span> : null}
            </div>
            <div className="detailLinks">
              {tmdbUrl ? <a href={tmdbUrl} target="_blank" rel="noreferrer">TMDB <ExternalLink size={15} /></a> : null}
              {doubanUrl ? <a href={doubanUrl} target="_blank" rel="noreferrer">豆瓣 <ExternalLink size={15} /></a> : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function MediaRow({ item, onOpen }: { item: MediaItem; onOpen?: () => void }) {
  const episodeTitle = item.title.trim();
  const genericEpisodeTitle = /^第\s*\d+\s*集$|^episode\s*\d+$|^s\d+e\d+$/i.test(episodeTitle);
  const episodePosition = [
    item.seasonNumber ? `第${item.seasonNumber}季` : "",
    item.episodeNumber ? `第${item.episodeNumber}集` : ""
  ].filter(Boolean).join(" ");
  const displayTitle = item.type === "episode" && item.seriesName ? item.seriesName : item.title;
  const displayMeta = item.type === "episode"
    ? [episodePosition || "剧集单集", !genericEpisodeTitle && episodeTitle !== displayTitle ? episodeTitle : ""].filter(Boolean).join(" · ")
    : item.type === "series" ? "剧集" : "电影";

  return (
    <article
      className={`rowItem ${onOpen ? "rowInteractive" : ""}`}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `查看《${displayTitle}》详情` : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      } : undefined}
    >
      <Poster item={item} compact />
      <div className="rowBody">
        <div className="rowTop">
          <strong title={displayTitle}>{displayTitle}</strong>
          <span>{item.year || formatDate(item.dateCreated || item.userData?.lastPlayedDate)}</span>
        </div>
        <div className="muted">{displayMeta}</div>
        {item.recentEpisodeRange ? <div className="episodeRange">{item.recentEpisodeRange}</div> : null}
        {item.userData?.progressPercent ? (
          <div className="progressLine">
            <div className="progress">
              <span style={{ width: `${item.userData.progressPercent}%` }} />
            </div>
            <strong>{Math.round(item.userData.progressPercent)}%</strong>
          </div>
        ) : null}
      </div>
      {onOpen ? <span className="rowOpenHint"><ChevronRight size={19} /></span> : null}
    </article>
  );
}

function LibraryMediaDetail({ item, session, onClose, onUpdated }: {
  item: MediaItem | null;
  session: EmbySession | null;
  onClose: () => void;
  onUpdated: (item: MediaItem) => void;
}) {
  const [details, setDetails] = useState<LibraryMediaDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState("");

  useEffect(() => {
    setDetails(null);
    setError("");
    if (!item || !session) return;
    let alive = true;
    setLoading(true);
    api.libraryDetails(session, item.id)
      .then((value) => alive && setDetails(value))
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [item?.id, session?.accessToken]);

  useEffect(() => {
    if (!item) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [item, onClose]);

  if (!item) return null;
  const itemId = item.id;
  const resolvedItem = details?.item || item;
  const seasons = details?.seasons || [];
  const allPlayed = resolvedItem.type === "movie"
    ? Boolean(resolvedItem.userData?.played)
    : seasons.length > 0 && seasons.every((season) => season.played);

  async function togglePlayed(played: boolean, seasonNumber?: number) {
    if (!session) return;
    const key = seasonNumber === undefined ? "all" : String(seasonNumber);
    setUpdating(key);
    setError("");
    try {
      const next = await api.setLibraryPlayed(session, itemId, played, seasonNumber);
      setDetails(next);
      onUpdated(next.item);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUpdating("");
    }
  }

  return (
    <div className="detailOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="detailModal libraryDetailModal" role="dialog" aria-modal="true" aria-label={`${resolvedItem.title}详情`}>
        <button className="detailClose" onClick={onClose} title="关闭详情" aria-label="关闭详情"><X size={21} /></button>
        <div className="detailVisual libraryDetailVisual">
          <div className="detailBackdrop detailBackdropFallback" />
          <div className="detailShade" />
          <div className="detailHeading">
            <div className="detailPoster"><Poster item={resolvedItem} /></div>
            <div className="detailTitleBlock">
              <div className="detailBadges">
                <span>{resolvedItem.type === "series" ? "剧集" : "电影"}</span>
                <span>Emby 片库</span>
                {allPlayed ? <span className="inLibraryBadge"><CheckCircle2 size={13} />已观看</span> : null}
              </div>
              <h1>{resolvedItem.title}</h1>
              {resolvedItem.originalTitle && resolvedItem.originalTitle !== resolvedItem.title ? <p>{resolvedItem.originalTitle}</p> : null}
            </div>
          </div>
        </div>
        <div className="detailContent">
          {loading ? <div className="detailLoading">正在读取 Emby 季度与观看状态。</div> : null}
          {error ? <div className="notice">{error}</div> : null}
          <div className="detailFacts">
            <div><span>媒体类型</span><strong>{resolvedItem.type === "series" ? "剧集" : "电影"}</strong></div>
            <div><span>年份</span><strong>{resolvedItem.year || "未知"}</strong></div>
            {resolvedItem.communityRating ? <div><span>Emby 评分</span><strong><Star size={16} fill="currentColor" />{resolvedItem.communityRating.toFixed(1)}</strong></div> : null}
            {resolvedItem.type === "series" ? <div><span>总季数</span><strong>{details ? `${details.totalSeasons} 季` : "读取中"}</strong></div> : null}
            {resolvedItem.type === "series" ? <div><span>总集数</span><strong>{details ? `${details.totalEpisodes} 集` : "读取中"}</strong></div> : null}
            {resolvedItem.type === "series" ? <div><span>已观看</span><strong>{details ? `${details.playedEpisodes}/${details.totalEpisodes} 集` : "读取中"}</strong></div> : null}
          </div>
          {resolvedItem.overview ? <div className="detailOverview"><h2>简介</h2><p>{resolvedItem.overview}</p></div> : null}
          <div className="libraryWatchSummary">
            <div>
              <strong>{resolvedItem.type === "series" ? "整部剧观看状态" : "观看状态"}</strong>
              <span>{allPlayed ? "已标记为已观看" : "当前为未全部观看"}</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={allPlayed}
              className={`libraryWatchToggle ${allPlayed ? "active" : ""}`}
              disabled={!details || Boolean(updating)}
              onClick={() => togglePlayed(!allPlayed)}
            >
              {allPlayed ? <Eye size={17} /> : <EyeOff size={17} />}
              {updating === "all" ? "更新中" : allPlayed ? "已观看" : "未观看"}
            </button>
          </div>
          {resolvedItem.type === "series" ? (
            <div className="librarySeasonSection">
              <div className="detailSectionTitle"><h2>季度观看状态</h2><span>{details ? `共 ${details.totalSeasons} 季` : "正在读取"}</span></div>
              {!loading && details && !seasons.length ? <div className="notice">Emby 中暂无季度数据。</div> : null}
              <div className="librarySeasonList">
                {seasons.map((season) => (
                  <article className="librarySeasonRow" key={season.seasonNumber}>
                    <div className="librarySeasonIndex">{season.seasonNumber === 0 ? "SP" : `S${String(season.seasonNumber).padStart(2, "0")}`}</div>
                    <div className="librarySeasonInfo">
                      <strong>{season.name}</strong>
                      <span>{season.episodeCount ? `已看 ${season.playedEpisodeCount}/${season.episodeCount} 集` : "集数未知"}</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={season.played}
                      className={`libraryWatchToggle ${season.played ? "active" : ""}`}
                      disabled={Boolean(updating)}
                      onClick={() => togglePlayed(!season.played, season.seasonNumber)}
                    >
                      {season.played ? <Eye size={17} /> : <EyeOff size={17} />}
                      {updating === String(season.seasonNumber) ? "更新中" : season.played ? "已观看" : "未观看"}
                    </button>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function LoginPanel({
  config,
  session,
  onLogin,
  onLogout
}: {
  config?: AppConfig;
  session: UserSession | null;
  onLogin: (session: UserSession) => void;
  onLogout: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (config?.requiresSetup) {
        onLogin(await api.setup(username, password));
      } else {
        onLogin(await api.login(username, password));
      }
      setPassword("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function linkEmby(event: FormEvent) {
    event.preventDefault();
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      onLogin(await api.linkEmby(session, username, password));
      setPassword("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (session) {
    const displayName = session.emby?.userName || session.username;
    return (
      <div className="accountStack">
        <div className="userBox">
          <div className="avatar">{displayName.slice(0, 1).toUpperCase()}</div>
          <div>
            <strong>{displayName}</strong>
            <span>{session.role === "admin" ? (session.emby ? "管理员 · 已关联 Emby" : "管理员") : "Emby 用户"}</span>
          </div>
          <button className="iconBtn" onClick={onLogout} title="退出登录" aria-label="退出登录">
            <LogOut size={18} />
          </button>
        </div>
        {session.role === "admin" && !session.emby ? (
          <form className="loginBox" onSubmit={linkEmby}>
            <div className="loginHint">关联 Emby 后读取最近入库</div>
            <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Emby 用户名" />
            <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Emby 密码" type="password" />
            {error ? <div className="errorText">{error}</div> : null}
            <button className="primaryBtn" disabled={busy}>
              <Link2 size={17} />
              {busy ? "关联中" : "关联 Emby"}
            </button>
          </form>
        ) : null}
      </div>
    );
  }

  const setup = Boolean(config?.requiresSetup);
  return (
    <form className="loginBox" onSubmit={submit}>
      {setup ? <div className="loginHint">首次使用请创建管理员账户</div> : null}
      <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={setup ? "管理员用户名" : "用户名"} />
      <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码" type="password" />
      {error ? <div className="errorText">{error}</div> : null}
      <button className="primaryBtn" disabled={busy}>
        {setup ? <ShieldCheck size={17} /> : <LogIn size={17} />}
        {busy ? "处理中" : setup ? "创建管理员" : "登录"}
      </button>
    </form>
  );
}

function Sidebar({
  view,
  setView,
  open,
  setOpen,
  config,
  session,
  onLogin,
  onLogout
}: {
  view: View;
  setView: (view: View) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  config?: AppConfig;
  session: UserSession | null;
  onLogin: (session: UserSession) => void;
  onLogout: () => void;
}) {
  return (
    <>
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brandBox">
          <span>影视库</span>
          <strong>{config?.appName || "TFEmby Web"}</strong>
        </div>
        <div className="navLabel">导航</div>
        <nav>
          {navItems.filter((item) => !item.adminOnly || session?.role === "admin").map((item) => (
            <button
              key={item.key}
              className={view === item.key ? "active" : ""}
              onClick={() => {
                setView(item.key);
                setOpen(false);
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebarBottom">
          <LoginPanel config={config} session={session} onLogin={onLogin} onLogout={onLogout} />
          <div className="buildTag">TFEmby Web v{config?.version || "0.6.14"}</div>
        </div>
      </aside>
      <button className={`scrim ${open ? "show" : ""}`} aria-label="关闭导航" onClick={() => setOpen(false)} />
    </>
  );
}

function Topbar({
  onMenu,
  dark,
  setDark,
  onRefresh
}: {
  onMenu: () => void;
  dark: boolean;
  setDark: (value: boolean) => void;
  onRefresh: () => void;
}) {
  return (
    <header className="topbar">
      <button className="iconBtn menuOnly" onClick={onMenu} title="导航" aria-label="导航">
        <Menu size={23} />
      </button>
      <div className="topSpacer" />
      <div className="topActions">
        <button className="iconBtn" onClick={onRefresh} title="刷新" aria-label="刷新">
          <RefreshCw size={19} />
        </button>
        <button className="iconBtn" onClick={() => setDark(!dark)} title="切换主题" aria-label="切换主题">
          {dark ? <Moon size={19} /> : <Sun size={19} />}
        </button>
      </div>
    </header>
  );
}

function FocusedChartView({ selected, session, onBack, onOpen }: { selected: ChartSection; session: EmbySession | null; onBack: () => void; onOpen: (item: ChartItem) => void }) {
  const [page, setPage] = useState(1);
  const [year, setYear] = useState("");
  const [genre, setGenre] = useState(selected.genre || "");
  const genreOptions = selected.media === "tv" ? tvGenres : movieGenres;
  const years = useMemo(() => Array.from({ length: new Date().getFullYear() - 1949 }, (_, index) => new Date().getFullYear() - index), []);
  const { data, loading, error } = useAsync(
    () => api.chart(selected.source, selected.chart, selected.media, selected.period, page, year, genre, session),
    [selected.source, selected.chart, selected.media, selected.period, page, year, genre, session?.accessToken],
    emptyChartPage
  );
  const items = visibleChartItems(data.items);
  const pages = pageNumbers(data.page, data.totalPages);

  return (
    <>
      <div className="chartFocusHead">
        <button type="button" className="chartBack" onClick={onBack} title="返回热榜" aria-label="返回热榜"><ChevronLeft size={20} /></button>
        <div>
          <h1>{selected.label}</h1>
          <p>按年份和类型浏览完整榜单</p>
        </div>
      </div>
      <div className="chartToolbar">
        <label>
          <span>年份</span>
          <select value={year} onChange={(event) => { setYear(event.target.value); setPage(1); }}>
            <option value="">全部年份</option>
            {years.map((value) => <option value={value} key={value}>{value} 年</option>)}
          </select>
        </label>
        <label>
          <span>影片类型</span>
          <select value={genre} onChange={(event) => { setGenre(event.target.value); setPage(1); }}>
            <option value="">全部类型</option>
            {genreOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <div className="chartCount">
          <strong>{data.totalResults.toLocaleString("zh-CN")}</strong>
          <span>条结果 · 第 {data.page}/{data.totalPages} 页</span>
        </div>
      </div>
      {error ? <div className="notice">{error}</div> : null}
      {loading ? <div className="loadingGrid" /> : items.length ? <div className="grid chartGrid">{items.map((item) => <ChartCard key={`${item.source}-${item.rank}-${item.title}`} item={item} onOpen={() => onOpen(item)} />)}</div> : <div className="notice">当前筛选条件下暂无 5.0 分以上的榜单内容。</div>}
      {data.totalPages > 1 ? (
        <nav className="pagination" aria-label="热榜分页">
          <button type="button" className="pageArrow" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))} title="上一页" aria-label="上一页"><ChevronLeft size={19} /></button>
          {pages.map((value, index) => (
            <div className="pageSlot" key={value}>
              {index > 0 && value - pages[index - 1] > 1 ? <span>…</span> : null}
              <button type="button" className={value === data.page ? "active" : ""} disabled={loading} onClick={() => setPage(value)}>{value}</button>
            </div>
          ))}
          <button type="button" className="pageArrow" disabled={page >= data.totalPages || loading} onClick={() => setPage((current) => Math.min(data.totalPages, current + 1))} title="下一页" aria-label="下一页"><ChevronRight size={19} /></button>
        </nav>
      ) : null}
    </>
  );
}

function ChartView({ session }: { session: EmbySession | null }) {
  const [activeTab, setActiveTab] = useState<ChartTab>("all");
  const [focused, setFocused] = useState<ChartSection | null>(null);
  const [detail, setDetail] = useState<ChartItem | null>(null);
  const currentTab = chartTabs.find((tab) => tab.key === activeTab) || chartTabs[0];

  return (
    <section className="panel chartsPanel">
      {focused ? (
        <FocusedChartView key={focused.id} selected={focused} session={session} onBack={() => setFocused(null)} onOpen={setDetail} />
      ) : (
        <>
          <div className="chartsIntro">
            <div>
              <h1>全网热榜</h1>
              <p>发现近期热门电影、剧集与高分榜单</p>
            </div>
          </div>
          <div className="chartTabs" role="tablist" aria-label="热榜分类">
            {chartTabs.map((tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === tab.key}
                className={activeTab === tab.key ? "active" : ""}
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
              >
                {tab.icon}<span>{tab.label}</span>
              </button>
            ))}
          </div>
          <div className="chartShelves">
            {currentTab.sections.map((section) => (
              <ChartShelf key={section.id} section={section} session={session} onMore={() => setFocused(section)} onOpen={setDetail} />
            ))}
          </div>
        </>
      )}
      <ChartDetail item={detail} session={session} onClose={() => setDetail(null)} />
    </section>
  );
}

function DiscoverView({ session }: { session: EmbySession | null }) {
  const [media, setMedia] = useState<"movie" | "tv">("movie");
  const [sort, setSort] = useState("popular-desc");
  const [genre, setGenre] = useState("");
  const [language, setLanguage] = useState("");
  const [year, setYear] = useState("");
  const [minScore, setMinScore] = useState(minimumVisibleScore);
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<ChartItem | null>(null);
  const genreOptions = media === "tv" ? tvGenres : movieGenres;
  const years = useMemo(() => Array.from({ length: new Date().getFullYear() - 1948 }, (_, index) => new Date().getFullYear() + 1 - index), []);
  const { data, loading, error } = useAsync(
    () => api.discover({ media, page, year, genre, language, minScore, sort }, session),
    [media, page, year, genre, language, minScore, sort, session?.accessToken],
    emptyChartPage
  );
  const items = visibleChartItems(data.items);
  const pages = pageNumbers(data.page, data.totalPages);

  function resetFilters() {
    setSort("popular-desc");
    setGenre("");
    setLanguage("");
    setYear("");
    setMinScore(minimumVisibleScore);
    setPage(1);
  }

  return (
    <section className="panel discoverPanel">
      <div className="discoverHead">
        <div>
          <span className="providerTag"><Compass size={15} />TMDB</span>
          <h1>探索发现</h1>
          <p>按喜好浏览电影与电视剧</p>
        </div>
        <button type="button" className="discoverReset" onClick={resetFilters}><RefreshCw size={16} />重置筛选</button>
      </div>

      <div className="discoverFilters">
        <div className="discoverFilterRow">
          <span className="discoverFilterLabel">类型</span>
          <div className="discoverChoices compactChoices">
            <button type="button" className={media === "movie" ? "active" : ""} onClick={() => { setMedia("movie"); setGenre(""); setPage(1); }}><Clapperboard size={16} />电影</button>
            <button type="button" className={media === "tv" ? "active" : ""} onClick={() => { setMedia("tv"); setGenre(""); setPage(1); }}><Tv size={16} />电视剧</button>
          </div>
        </div>
        <div className="discoverFilterRow">
          <span className="discoverFilterLabel">排序</span>
          <div className="discoverChoices">
            {discoverSorts.map(([value, label]) => <button type="button" className={sort === value ? "active" : ""} key={value} onClick={() => { setSort(value); setPage(1); }}>{label}</button>)}
          </div>
        </div>
        <div className="discoverFilterRow">
          <span className="discoverFilterLabel">影片类型</span>
          <div className="discoverChoices scrollChoices">
            <button type="button" className={!genre ? "active" : ""} onClick={() => { setGenre(""); setPage(1); }}>全部</button>
            {genreOptions.map(([value, label]) => <button type="button" className={genre === String(value) ? "active" : ""} key={value} onClick={() => { setGenre(String(value)); setPage(1); }}>{label}</button>)}
          </div>
        </div>
        <div className="discoverFilterRow">
          <span className="discoverFilterLabel">语言</span>
          <div className="discoverChoices scrollChoices">
            {discoverLanguages.map(([value, label]) => <button type="button" className={language === value ? "active" : ""} key={value || "all"} onClick={() => { setLanguage(value); setPage(1); }}>{label}</button>)}
          </div>
        </div>
        <div className="discoverFilterRow discoverRangeRow">
          <span className="discoverFilterLabel">年份与评分</span>
          <label className="discoverYear">
            <select value={year} onChange={(event) => { setYear(event.target.value); setPage(1); }}>
              <option value="">全部年份</option>
              {years.map((value) => <option value={value} key={value}>{value} 年</option>)}
            </select>
          </label>
          <label className="scoreRange">
            <span>最低评分</span>
            <input type="range" min="5" max="9" step="0.5" value={minScore} onChange={(event) => { setMinScore(Math.max(minimumVisibleScore, Number(event.target.value))); setPage(1); }} />
            <strong>{minScore.toFixed(1)}+</strong>
          </label>
        </div>
      </div>

      <div className="discoverResultHead">
        <div><h2>{media === "movie" ? "电影" : "电视剧"}</h2></div>
        <div><strong>{data.totalResults.toLocaleString("zh-CN")}</strong><span>条结果 · 第 {data.page}/{data.totalPages} 页</span></div>
      </div>
      {error ? <div className="notice">{error}</div> : null}
      {loading ? <div className="loadingGrid" /> : items.length ? (
        <div className="grid discoverGrid">
          {items.map((item) => <ChartCard showRank={false} key={`${item.externalIds.tmdb || item.rank}-${item.title}`} item={item} onOpen={() => setDetail(item)} />)}
        </div>
      ) : <div className="notice">当前筛选条件下暂无 5.0 分以上的内容。</div>}
      {data.totalPages > 1 ? (
        <nav className="pagination" aria-label="探索分页">
          <button type="button" className="pageArrow" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))} title="上一页" aria-label="上一页"><ChevronLeft size={19} /></button>
          {pages.map((value, index) => (
            <div className="pageSlot" key={value}>
              {index > 0 && value - pages[index - 1] > 1 ? <span>…</span> : null}
              <button type="button" className={value === data.page ? "active" : ""} disabled={loading} onClick={() => setPage(value)}>{value}</button>
            </div>
          ))}
          <button type="button" className="pageArrow" disabled={page >= data.totalPages || loading} onClick={() => setPage((current) => Math.min(data.totalPages, current + 1))} title="下一页" aria-label="下一页"><ChevronRight size={19} /></button>
        </nav>
      ) : null}
      <ChartDetail item={detail} session={session} onClose={() => setDetail(null)} />
    </section>
  );
}

function Overview({ session }: { session: EmbySession | null }) {
  const stats = useAsync(() => (session ? api.stats(session) : Promise.resolve({ movies: 0, series: 0, played: 0, resume: 0, resumeProgressPercent: 0, latest: 0 })), [session?.accessToken], {
    movies: 0,
    series: 0,
    played: 0,
    resume: 0,
    resumeProgressPercent: 0,
    latest: 0
  });
  const resume = useAsync(() => (session ? api.resume(session) : Promise.resolve([])), [session?.accessToken], [] as MediaItem[]);

  return (
    <section className="overview">
      <div className="stats">
        <div><strong>{stats.data.movies}</strong><span>电影</span></div>
        <div><strong>{stats.data.series}</strong><span>剧集</span></div>
        <div><strong>{stats.data.played}</strong><span>已看</span></div>
        <div className="progressStat">
          <div className="circularProgress" style={{ background: `conic-gradient(var(--brand) ${stats.data.resumeProgressPercent}%, color-mix(in srgb, var(--line) 75%, var(--surface-soft)) 0)` }}>
            <strong>{stats.data.resumeProgressPercent}%</strong>
          </div>
          <span>平均进度 · {stats.data.resume} 项</span>
        </div>
      </div>
      {!session ? <div className="notice">登录 Emby 后显示库内资源、播放历史和榜单观看状态。</div> : null}
      <section className="listPanel overviewResumePanel">
        <h2>继续观看</h2>
        <div className="rows">{resume.data.slice(0, 6).map((item) => <MediaRow key={item.id} item={item} />)}</div>
      </section>
    </section>
  );
}

function SearchView({ session }: { session: EmbySession | null }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MediaItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<MediaItem | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || !query.trim()) return;
    setBusy(true);
    setSearched(false);
    setResults([]);
    setError("");
    try {
      setResults(await api.search(session, query.trim()));
      setSearched(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="sectionHead">
        <div>
          <h1>片库搜索</h1>
          <p>模糊查询库中电影与剧集</p>
        </div>
      </div>
      <form className="searchBar" onSubmit={submit}>
        <Search size={20} />
        <input value={query} onChange={(event) => { setQuery(event.target.value); setSearched(false); }} placeholder="输入电影或剧集名称" disabled={!session || busy} />
        <button disabled={!session || busy}>{busy ? "搜索中" : "搜索"}</button>
      </form>
      {error ? <div className="notice">{error}</div> : null}
      {!session ? <div className="notice">请先登录 Emby。</div> : null}
      {session && searched && !results.length && !error ? <div className="notice">片库中没有找到“{query.trim()}”。</div> : null}
      <div className="rows">{results.map((item) => <MediaRow key={item.id} item={item} onOpen={() => setSelected(item)} />)}</div>
      <LibraryMediaDetail
        item={selected}
        session={session}
        onClose={() => setSelected(null)}
        onUpdated={(updated) => {
          setSelected(updated);
          setResults((current) => current.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
        }}
      />
    </section>
  );
}

function TimelineView({ session, kind }: { session: EmbySession | null; kind: "resume" | "latest" }) {
  const [tab, setTab] = useState<"resume" | "history">(kind === "resume" ? "resume" : "history");
  const loader = () => {
    if (!session) return Promise.resolve([] as MediaItem[]);
    if (kind === "latest") return api.latest(session);
    return tab === "resume" ? api.resume(session) : api.history(session);
  };
  const { data, error } = useAsync(loader, [session?.accessToken, kind, tab], [] as MediaItem[]);

  return (
    <section className="panel">
      <div className="sectionHead">
        <div>
          <h1>{kind === "latest" ? "最近新增" : "继续观看"}</h1>
          <p>{kind === "latest" ? "历史入库信息" : "历史播放信息与进度"}</p>
        </div>
        {kind === "resume" ? (
          <div className="segmented">
            <button className={tab === "resume" ? "active" : ""} onClick={() => setTab("resume")}>进度</button>
            <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>历史</button>
          </div>
        ) : null}
      </div>
      {error ? <div className="notice">{error}</div> : null}
      {!session ? <div className="notice">请先登录 Emby。</div> : null}
      <div className="rows wide">{data.map((item) => <MediaRow key={item.id} item={item} />)}</div>
    </section>
  );
}

function RequestRow({ item, admin, onStatus, updating }: { item: MediaRequest; admin?: boolean; onStatus?: (status: RequestStatus) => void; updating?: boolean }) {
  const active = item.status === "pending" || item.status === "approved";
  return (
    <article className="requestRow">
      <Poster item={item} compact />
      <div className="requestBody">
        <div className="requestTitle">
          <strong>{item.title}</strong>
          <span className={`statusTag status-${item.status}`}>{requestStatus[item.status]}</span>
        </div>
        <div className="requestMeta">
          <span>{item.mediaType === "tv" ? "剧集" : "电影"}</span>
          {item.seasonNumber ? <span>第 {item.seasonNumber} 季</span> : null}
          {item.expectedEpisodeCount ? <span>共 {item.expectedEpisodeCount} 集</span> : null}
          <span>TMDB {item.tmdbId}</span>
          {item.year ? <span>{item.year}</span> : null}
          {admin ? <span>申请人：{item.requestedBy.username}</span> : null}
          <span>{formatDate(item.createdAt)}</span>
          {item.fulfilledAt ? <span>入库：{formatDate(item.fulfilledAt)}</span> : null}
        </div>
        {admin && onStatus && active ? (
          <div className="requestDecisionActions">
            <button type="button" className={`requestApprove ${item.status === "approved" ? "active" : ""}`} disabled={updating || item.status === "approved"} onClick={() => onStatus("approved")}>
              <CheckCircle2 size={16} />{item.status === "approved" ? "已接受，等待入库" : updating ? "处理中" : "接受"}
            </button>
            <button type="button" className="requestReject" disabled={updating} onClick={() => onStatus("rejected")}>
              <X size={16} />拒绝
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function RequestStatusNotice({ session }: { session: UserSession | null }) {
  const [notice, setNotice] = useState<MediaRequest | null>(null);

  useEffect(() => {
    if (!session || session.role === "admin") {
      setNotice(null);
      return;
    }
    let alive = true;
    const storageKey = `tfemby-request-notice-${session.userId}`;
    const refresh = async () => {
      try {
        const requests = await api.requests(session);
        const latest = requests
          .filter((item) => item.status !== "pending")
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        const seenAt = localStorage.getItem(storageKey) || "";
        if (alive && latest && latest.updatedAt > seenAt) {
          setNotice((current) => current?.id === latest.id && current.status === latest.status ? current : latest);
        }
      } catch {
        // The regular request page still shows the persisted status when polling is unavailable.
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [session?.token, session?.userId, session?.role]);

  if (!notice || !session) return null;
  const message = notice.status === "approved"
    ? "管理员已接受您的求片申请"
    : notice.status === "fulfilled"
      ? "您申请的资源已经入库"
      : "管理员已拒绝您的求片申请";

  return (
    <aside className={`requestStatusNotice status-${notice.status}`} role="status" aria-live="polite">
      <span className="requestNoticeIcon">{notice.status === "rejected" ? <X size={19} /> : <CheckCircle2 size={19} />}</span>
      <div><strong>{message}</strong><span>《{notice.title}》{notice.seasonNumber ? `第 ${notice.seasonNumber} 季` : ""}</span></div>
      <button type="button" onClick={() => { localStorage.setItem(`tfemby-request-notice-${session.userId}`, notice.updatedAt); setNotice(null); }} title="关闭通知" aria-label="关闭通知"><X size={17} /></button>
    </aside>
  );
}

function SeasonPicker({ item, seasons, loading, error, requests, submitting, onRequest, onClose }: {
  item: ChartItem | null;
  seasons: TvSeason[];
  loading: boolean;
  error: string;
  requests: MediaRequest[];
  submitting: string;
  onRequest: (seasonNumber: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!item) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [item, onClose]);
  if (!item) return null;
  const tmdbId = item.externalIds.tmdb || "";
  return (
    <div className="seasonOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="seasonModal" role="dialog" aria-modal="true" aria-label={`选择《${item.title}》的季度`}>
        <div className="seasonModalHead">
          <div>
            <span>选择求片季度</span>
            <h2>{item.title}</h2>
          </div>
          <button type="button" onClick={onClose} title="关闭" aria-label="关闭季度选择"><X size={20} /></button>
        </div>
        {loading ? <div className="notice">正在读取季度信息。</div> : null}
        {error ? <div className="notice">{error}</div> : null}
        {!loading && !error && !seasons.length ? <div className="notice">暂无可申请的季度。</div> : null}
        <div className="seasonList">
          {seasons.map((season) => {
            const request = requests.find((candidate) =>
              candidate.tmdbId === tmdbId &&
              candidate.mediaType === "tv" &&
              (candidate.seasonNumber == null || candidate.seasonNumber === season.seasonNumber) &&
              candidate.status !== "rejected"
            );
            const submitKey = `${tmdbId}:${season.seasonNumber}`;
            const disabled = season.inLibrary || Boolean(request) || submitting === submitKey;
            return (
              <div className="seasonRow" key={season.seasonNumber}>
                <div>
                  <strong>{season.name || `第 ${season.seasonNumber} 季`}</strong>
                  <span>{season.episodeCount ? `${season.episodeCount} 集` : "集数未知"}{season.airDate ? ` · ${season.airDate}` : ""}</span>
                </div>
                <button type="button" disabled={disabled} className={season.inLibrary ? "inLibrary" : ""} onClick={() => onRequest(season.seasonNumber)}>
                  {season.inLibrary || request ? <CheckCircle2 size={16} /> : <Send size={16} />}
                  {season.inLibrary ? "库中存在" : request ? requestStatus[request.status] : submitting === submitKey ? "提交中" : `申请第 ${season.seasonNumber} 季`}
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function RequestView({ session }: { session: UserSession | null }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChartItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [seasonTarget, setSeasonTarget] = useState<ChartItem | null>(null);
  const [seasonMap, setSeasonMap] = useState<Record<string, TvSeason[]>>({});
  const [seasonLoading, setSeasonLoading] = useState("");
  const [seasonError, setSeasonError] = useState("");
  const [updating, setUpdating] = useState("");
  const requests = useAsync(() => (session ? api.requests(session) : Promise.resolve([])), [session?.token], [] as MediaRequest[]);

  useEffect(() => {
    if (!session) return;
    const refresh = () => requests.reload().catch(() => undefined);
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [session?.token]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!session || !query.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setResults(visibleChartItems(await api.searchTmdb(session, query.trim())));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openSeasons(item: ChartItem) {
    const tmdbId = item.externalIds.tmdb;
    if (!session || !tmdbId) return;
    setSeasonTarget(item);
    setSeasonError("");
    if (seasonMap[tmdbId]) return;
    setSeasonLoading(tmdbId);
    try {
      const seasons = await api.tvSeasons(session, tmdbId);
      setSeasonMap((current) => ({ ...current, [tmdbId]: seasons }));
    } catch (err) {
      setSeasonError((err as Error).message);
    } finally {
      setSeasonLoading("");
    }
  }

  async function submitRequest(item: ChartItem, seasonNumber?: number) {
    const tmdbId = item.externalIds.tmdb;
    if (!session || !tmdbId) return;
    const submitKey = seasonNumber ? `${tmdbId}:${seasonNumber}` : tmdbId;
    setSubmitting(submitKey);
    setError("");
    setMessage("");
    try {
      await api.createRequest(session, tmdbId, item.mediaType, seasonNumber);
      await requests.reload();
      setMessage(`已提交《${item.title}》${seasonNumber ? `第 ${seasonNumber} 季` : ""}。`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting("");
    }
  }

  async function updateRequest(item: MediaRequest, status: RequestStatus) {
    if (!session || session.role !== "admin") return;
    setUpdating(item.id);
    setError("");
    setMessage("");
    try {
      await api.updateRequest(session, item.id, status);
      await requests.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUpdating("");
    }
  }

  const activeRequests = requests.data.filter((item) => item.status === "pending" || item.status === "approved");
  const fulfilledRequests = requests.data.filter((item) => item.status === "fulfilled");
  const rejectedRequests = requests.data.filter((item) => item.status === "rejected");

  return (
    <section className="panel">
      <div className="sectionHead">
        <div>
          <h1>求片申请</h1>
          <p>从 TMDB 选择电影或剧集</p>
        </div>
      </div>
      {!session ? <div className="notice">登录后可以提交求片申请。</div> : null}
      {session ? (
        <form className="searchBar" onSubmit={search}>
          <Search size={20} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索电影或剧集" />
          <button disabled={busy}>{busy ? "搜索中" : "搜索"}</button>
        </form>
      ) : null}
      {error || requests.error ? <div className="notice">{error || requests.error}</div> : null}
      {message ? <div className="successText">{message}</div> : null}
      {session && activeRequests.length ? (
        <div className="requestSection">
          <div className="subhead"><h2>求片处理中</h2><span>{activeRequests.length} 条</span></div>
          <div className="requestList">
            {activeRequests.map((item) => (
              <RequestRow
                key={item.id}
                item={item}
                admin={session.role === "admin"}
                updating={updating === item.id}
                onStatus={session.role === "admin" ? (status) => updateRequest(item, status) : undefined}
              />
            ))}
          </div>
        </div>
      ) : null}
      {session && fulfilledRequests.length ? (
        <div className="requestSection requestArchiveSection">
          <div className="subhead"><h2>已入库</h2><span>{fulfilledRequests.length} 条</span></div>
          <div className="requestList">{fulfilledRequests.map((item) => <RequestRow key={item.id} item={item} />)}</div>
        </div>
      ) : null}
      {session && rejectedRequests.length ? (
        <div className="requestSection requestArchiveSection">
          <div className="subhead"><h2>已拒绝</h2><span>{rejectedRequests.length} 条</span></div>
          <div className="requestList">{rejectedRequests.map((item) => <RequestRow key={item.id} item={item} />)}</div>
        </div>
      ) : null}
      {results.length ? (
        <div className="requestSection">
          <h2>TMDB 搜索结果</h2>
          <div className="grid requestGrid">
            {results.map((item) => {
              const tmdbId = item.externalIds.tmdb || "";
              const existing = item.mediaType === "movie" ? requests.data.find((request) => request.tmdbId === tmdbId && request.mediaType === "movie" && request.status !== "rejected") : undefined;
              return (
                <article className="mediaCard" key={`${item.mediaType}-${tmdbId}`}>
                  <Poster item={item} />
                  <div className="mediaTitle" title={item.title}>{item.title}</div>
                  <div className="metaLine"><span>{item.mediaType === "tv" ? "剧集" : "电影"}</span><span>·</span><span>{item.year || "未知"}</span></div>
                  <button className="requestAction" disabled={Boolean(existing) || submitting === tmdbId} onClick={() => item.mediaType === "tv" ? openSeasons(item) : submitRequest(item)}>
                    {item.mediaType === "tv" ? <Layers3 size={16} /> : existing ? <CheckCircle2 size={16} /> : <Send size={16} />}
                    {item.mediaType === "tv" ? "选择季度" : existing ? requestStatus[existing.status] : submitting === tmdbId ? "提交中" : "申请"}
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
      <SeasonPicker
        item={seasonTarget}
        seasons={seasonTarget ? seasonMap[seasonTarget.externalIds.tmdb || ""] || [] : []}
        loading={Boolean(seasonTarget && seasonLoading === seasonTarget.externalIds.tmdb)}
        error={seasonError}
        requests={requests.data}
        submitting={submitting}
        onRequest={(seasonNumber) => seasonTarget && submitRequest(seasonTarget, seasonNumber)}
        onClose={() => setSeasonTarget(null)}
      />
    </section>
  );
}

const defaultBotConfig: TgBotConfig = {
  telegramBotToken: "",
  telegramChatId: "",
  telegramMenuUserIds: "",
  tmdbApiKey: "",
  tmdbLanguage: "zh-CN",
  embyUrl: "",
  embyApiKey: "",
  embyUserId: "",
  webhookSecret: "",
  doubanFallbackEnabled: true,
  enableCovers: true,
  overviewMaxLength: 420,
  monitoredEvents: "library.new,item.added,item.created,itemadded,playback.start",
  includeTypes: ["Movie", "Episode"],
  pollIntervalSeconds: 300,
  latestLimit: 20,
  notifyFirstRun: false,
  notifyPlayback: true
};

function SettingField({ label, value, onChange, placeholder, type = "text", min, max }: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number";
  min?: number;
  max?: number;
}) {
  return (
    <label className="settingsField">
      <span>{label}</span>
      <input type={type} min={min} max={max} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function EndpointListField({ label, value, onChange, presets, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  presets: Array<{ label: string; value: string }>;
  placeholder: string;
}) {
  const values = value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
  const toggle = (endpoint: string) => {
    const next = values.includes(endpoint) ? values.filter((item) => item !== endpoint) : [...values, endpoint];
    onChange(Array.from(new Set(next)).join("\n"));
  };
  return (
    <div className="settingsEndpointField">
      <span>{label}</span>
      <div className="endpointPresets">
        {presets.map((preset) => {
          const active = values.includes(preset.value);
          return (
            <button type="button" className={active ? "active" : ""} aria-pressed={active} key={preset.value} onClick={() => toggle(preset.value)}>
              {active ? <CheckCircle2 size={15} /> : <Link2 size={15} />}{preset.label}
            </button>
          );
        })}
      </div>
      <textarea rows={2} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      <small>可选择多个内置地址，也可按每行一个地址填写自定义服务。</small>
    </div>
  );
}

function SecretSettingField({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="settingsField">
      <span>{label}</span>
      <div className="secretField">
        <input type={visible ? "text" : "password"} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoComplete="off" />
        <button type="button" onClick={() => setVisible((current) => !current)} title={visible ? "隐藏" : "显示"} aria-label={visible ? `隐藏${label}` : `显示${label}`}>
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
    </label>
  );
}

function ToggleSetting({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="settingsToggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggleTrack"><span /></span>
    </label>
  );
}

function AdminSettingsForm({ session, onSaved }: { session: UserSession; onSaved: () => void }) {
  const settings = useAsync(() => api.adminSettings(session), [session.token], null as AdminSettings | null);
  const [draft, setDraft] = useState<AdminSettings | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [latency, setLatency] = useState<LatencyStatus | null>(null);

  useEffect(() => {
    if (settings.data) {
      setDraft({
        ...settings.data,
        bot: settings.data.bot || { ...defaultBotConfig }
      });
    }
  }, [settings.data]);

  function updateWeb<Key extends keyof WebSettings>(key: Key, value: WebSettings[Key]) {
    setDraft((current) => current ? { ...current, web: { ...current.web, [key]: value } } : current);
  }

  function updateBot<Key extends keyof TgBotConfig>(key: Key, value: TgBotConfig[Key]) {
    setDraft((current) => current?.bot ? { ...current, bot: { ...current.bot, [key]: value } } : current);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy("save");
    setError("");
    setMessage("");
    try {
      const saved = await api.saveAdminSettings(session, draft);
      setDraft({ ...saved, bot: saved.bot || draft.bot });
      setMessage(saved.warning || "设置已保存并立即生效。");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function test(target: "emby" | "tmdb" | "douban" | "telegram") {
    if (!draft) return;
    setBusy(target);
    setError("");
    setMessage("");
    try {
      const saved = await api.saveAdminSettings(session, draft);
      setDraft({ ...saved, bot: saved.bot || draft.bot });
      onSaved();
      if (saved.warning) throw new Error(saved.warning);
      const result = await api.testAdminSetting(session, target);
      setMessage(result.messages?.join("；") || "连接测试成功。");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function measureLatency() {
    if (!draft) return;
    setBusy("latency");
    setError("");
    setMessage("");
    try {
      const saved = await api.saveAdminSettings(session, draft);
      setDraft({ ...saved, bot: saved.bot || draft.bot });
      onSaved();
      if (saved.warning) throw new Error(saved.warning);
      setLatency(await api.latencyStatus(session));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function sendTelegramMenu() {
    if (!draft) return;
    setBusy("menu");
    setError("");
    setMessage("");
    try {
      const saved = await api.saveAdminSettings(session, draft);
      setDraft({ ...saved, bot: saved.bot || draft.bot });
      onSaved();
      if (saved.warning) throw new Error(saved.warning);
      const result = await api.telegramAction(session, "menu") as { sent?: number; failed?: number };
      setMessage(`Telegram 菜单已发送：${result.sent || 0} 个用户${result.failed ? `，失败 ${result.failed} 个` : ""}。`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (settings.loading && !draft) return <div className="notice">正在读取系统设置。</div>;
  if (!draft?.bot) return <div className="notice">{settings.error || "系统设置暂时无法读取。"}</div>;

  const bot = draft.bot;
  const webhookBaseUrl = `${window.location.origin}/webhook/emby`;
  const webhookUrl = bot.webhookSecret ? `${webhookBaseUrl}?token=${encodeURIComponent(bot.webhookSecret)}` : webhookBaseUrl;
  const setNumber = (key: "pollIntervalSeconds" | "latestLimit" | "overviewMaxLength", value: string) => updateBot(key, Number(value));
  const toggleIncludeType = (type: string, checked: boolean) => {
    const next = checked ? Array.from(new Set([...bot.includeTypes, type])) : bot.includeTypes.filter((item) => item !== type);
    updateBot("includeTypes", next);
  };
  async function copyWebhookUrl() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("无法复制，请手动选择 Webhook 地址。");
    }
  }

  return (
    <form className="settingsForm" onSubmit={save}>
      <div className="settingsStatus">
        <div>
          <strong>系统设置</strong>
          <span>配置保存在数据卷中，保存后立即生效 · 时区：Asia/Shanghai（北京时间）</span>
        </div>
        <span className={`connectionPill ${draft.notificationReady ? "online" : ""}`}>
          <span />{draft.notificationReady ? "通知服务已就绪" : "通知服务异常"}
        </span>
      </div>

      {error || settings.error ? <div className="notice">{error || settings.error}</div> : null}
      {message ? <div className={message.includes("失败") ? "notice" : "successText"}>{message}</div> : null}

      <div className="settingsGroup">
        <div className="settingsGroupHead"><h3>基础与 Emby</h3><span>用户登录和媒体库连接</span></div>
        <div className="settingsGrid">
          <SettingField label="项目名称" value={draft.web.appName} onChange={(value) => updateWeb("appName", value)} placeholder="TFEmby Web" />
          <SettingField label="Emby 服务器地址" value={draft.web.embyServerUrl} onChange={(value) => updateWeb("embyServerUrl", value)} placeholder="http://192.168.1.10:8096" />
          <SecretSettingField label="Emby API Key" value={bot.embyApiKey} onChange={(value) => updateBot("embyApiKey", value)} />
          <SettingField label="Emby 用户 ID" value={bot.embyUserId} onChange={(value) => updateBot("embyUserId", value)} placeholder="可留空自动选择" />
        </div>
        <div className="settingsTestRow">
          <button type="button" className="softBtn" disabled={Boolean(busy)} onClick={() => test("emby")}><TestTube2 size={16} />{busy === "emby" ? "测试中" : "测试 Emby"}</button>
        </div>
      </div>

      <div className="settingsGroup">
        <div className="settingsGroupHead"><h3>榜单与元数据</h3><span>TMDB 榜单、搜索和豆瓣海报补全</span></div>
        <div className="settingsGrid">
          <EndpointListField
            label="TMDB API 服务地址"
            value={draft.web.tmdbApiBases}
            onChange={(value) => updateWeb("tmdbApiBases", value)}
            presets={[
              { label: "api.themoviedb.org", value: "https://api.themoviedb.org" },
              { label: "api.tmdb.org", value: "https://api.tmdb.org" }
            ]}
            placeholder="https://api.themoviedb.org"
          />
          <EndpointListField
            label="TMDB 图片服务地址"
            value={draft.web.tmdbImageBases}
            onChange={(value) => updateWeb("tmdbImageBases", value)}
            presets={[{ label: "image.tmdb.org", value: "https://image.tmdb.org" }]}
            placeholder="https://image.tmdb.org"
          />
          <SecretSettingField label="TMDB API Key" value={draft.web.tmdbApiKey} onChange={(value) => updateWeb("tmdbApiKey", value)} />
          <SecretSettingField label="TMDB Bearer Token" value={draft.web.tmdbBearerToken} onChange={(value) => updateWeb("tmdbBearerToken", value)} />
          <SettingField label="TMDB 语言" value={bot.tmdbLanguage} onChange={(value) => updateBot("tmdbLanguage", value)} placeholder="zh-CN" />
          <SettingField label="豆瓣 API 地址" value={draft.web.doubanApiBase} onChange={(value) => updateWeb("doubanApiBase", value)} placeholder="可留空使用公开搜索兜底" />
        </div>
        <div className="settingsTestRow">
          <button type="button" className="softBtn" disabled={Boolean(busy)} onClick={() => test("tmdb")}><TestTube2 size={16} />{busy === "tmdb" ? "测试中" : "测试 TMDB"}</button>
          <button type="button" className="softBtn" disabled={Boolean(busy)} onClick={() => test("douban")}><TestTube2 size={16} />{busy === "douban" ? "测试中" : "测试豆瓣"}</button>
        </div>
      </div>

      <div className="settingsGroup">
        <div className="settingsGroupHead"><h3>Telegram 通知</h3><span>求片、入库和用户播放消息推送</span></div>
        <div className="settingsGrid">
          <SecretSettingField label="Bot Token" value={draft.web.telegramBotToken} onChange={(value) => updateWeb("telegramBotToken", value)} />
          <SettingField label="Chat ID" value={draft.web.telegramChatId} onChange={(value) => updateWeb("telegramChatId", value)} placeholder="多个 ID 使用英文逗号分隔" />
          <SettingField label="菜单用户 ID" value={bot.telegramMenuUserIds} onChange={(value) => updateBot("telegramMenuUserIds", value)} placeholder="允许使用机器人菜单的 Telegram 用户 ID" />
          <SettingField label="Telegram API 地址" value={draft.web.telegramApiBase} onChange={(value) => updateWeb("telegramApiBase", value)} placeholder="https://api.telegram.org" />
        </div>
        <div className="settingsHelp">菜单用户需要先在 Telegram 私聊机器人并发送 /start，再保存用户 ID 并点击“发送菜单”。</div>
        <div className="settingsTestRow">
          <button type="button" className="softBtn" disabled={Boolean(busy)} onClick={() => test("telegram")}><TestTube2 size={16} />{busy === "telegram" ? "测试中" : "测试 Telegram"}</button>
          <button type="button" className="softBtn" disabled={Boolean(busy)} onClick={sendTelegramMenu}><Send size={16} />{busy === "menu" ? "发送中" : "发送菜单"}</button>
        </div>
      </div>

      <div className="settingsGroup">
        <div className="settingsGroupHead"><h3>网络代理</h3><span>仅作用于 Telegram 与 TMDB</span></div>
        <div className="settingsGrid">
          <SettingField label="HTTP/HTTPS 代理地址" value={draft.web.proxyUrl} onChange={(value) => updateWeb("proxyUrl", value)} placeholder="http://192.168.1.10:7890" />
        </div>
        <div className="settingsSwitches proxySwitches">
          <ToggleSetting label="启用 TG/TMDB 代理" checked={draft.web.proxyEnabled} onChange={(value) => updateWeb("proxyEnabled", value)} />
        </div>
        <div className="settingsTestRow">
          <button type="button" className="softBtn" disabled={Boolean(busy)} onClick={measureLatency}><Gauge size={16} />{busy === "latency" ? "测速中" : "测试延迟"}</button>
        </div>
        {latency ? (
          <div className="latencyGrid">
            {latency.results.map((item) => (
              <div className={`latencyItem ${item.ok ? "online" : "offline"}`} key={item.target}>
                <div><span className="connectionDot" /><strong>{item.label}</strong></div>
                <b>{item.latencyMs === null ? "未启用" : `${item.latencyMs} ms`}</b>
                <span>{item.status}{item.target !== "proxy" ? ` · ${item.viaProxy ? "代理" : "直连"}` : ""}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="settingsGroup">
        <div className="settingsGroupHead"><h3>通知高级设置</h3><span>Webhook、入库扫描、封面和元数据</span></div>
        <div className="webhookGuide">
          <div className="webhookGuideHead">
            <div>
              <span className="webhookGuideIcon"><Webhook size={19} /></span>
              <div><strong>Emby Webhook 配置</strong><span>在 Emby 后台的“通知 / Webhooks”中新增通知</span></div>
            </div>
            <button type="button" className="softBtn" onClick={copyWebhookUrl}><Copy size={16} />{copied ? "已复制" : "复制地址"}</button>
          </div>
          <div className="webhookAddress">
            <span>默认地址</span>
            <code>{webhookUrl}</code>
          </div>
          <div className="webhookSpecs">
            <div><span>名称</span><strong>TFEmby Web</strong></div>
            <div><span>请求内容类型</span><strong>application/json</strong></div>
            <div><span>入库通知事件</span><strong>新增媒体 / Item Added</strong></div>
            <div><span>播放通知事件</span><strong>播放开始 / Playback Start</strong></div>
          </div>
          <p>只需选择“新增媒体”和“播放开始”两类事件。保存后可在 Emby 中发送测试通知，后台状态会显示最近一次 Webhook 接收时间。</p>
        </div>
        <div className="settingsGrid">
          <SecretSettingField label="Webhook 密钥" value={bot.webhookSecret} onChange={(value) => updateBot("webhookSecret", value)} />
          <SettingField label="监听事件" value={bot.monitoredEvents} onChange={(value) => updateBot("monitoredEvents", value)} />
          <SettingField label="扫描间隔（秒）" type="number" min={60} max={86400} value={bot.pollIntervalSeconds} onChange={(value) => setNumber("pollIntervalSeconds", value)} />
          <SettingField label="最近入库数量" type="number" min={1} max={100} value={bot.latestLimit} onChange={(value) => setNumber("latestLimit", value)} />
          <SettingField label="简介最大长度" type="number" min={80} max={2000} value={bot.overviewMaxLength} onChange={(value) => setNumber("overviewMaxLength", value)} />
        </div>
        <div className="settingsSwitches">
          <ToggleSetting label="通知首次扫描" checked={bot.notifyFirstRun} onChange={(value) => updateBot("notifyFirstRun", value)} />
          <ToggleSetting label="播放开始通知" checked={bot.notifyPlayback} onChange={(value) => updateBot("notifyPlayback", value)} />
          <ToggleSetting label="发送封面" checked={bot.enableCovers} onChange={(value) => updateBot("enableCovers", value)} />
          <ToggleSetting label="豆瓣兜底" checked={bot.doubanFallbackEnabled} onChange={(value) => updateBot("doubanFallbackEnabled", value)} />
        </div>
        <div className="settingsChecks">
          <span>监控类型</span>
          {[{ value: "Movie", label: "电影" }, { value: "Series", label: "剧集" }, { value: "Episode", label: "单集" }].map((item) => (
            <label key={item.value}><input type="checkbox" checked={bot.includeTypes.includes(item.value)} onChange={(event) => toggleIncludeType(item.value, event.target.checked)} />{item.label}</label>
          ))}
        </div>
      </div>

      <div className="settingsSaveBar">
        <span>配置由 TFEmby Web 统一保存并立即生效</span>
        <button className="primaryBtn settingsSave" disabled={Boolean(busy)}><Save size={17} />{busy === "save" ? "保存中" : "保存设置"}</button>
      </div>
    </form>
  );
}

function AdminView({ session, onConfigChange }: { session: UserSession | null; onConfigChange: () => void }) {
  const latest = useAsync(() => (session?.emby ? api.latest(session.emby) : Promise.resolve([])), [session?.emby?.accessToken], [] as MediaItem[]);
  const requests = useAsync(() => (session?.role === "admin" ? api.requests(session) : Promise.resolve([])), [session?.token], [] as MediaRequest[]);
  const telegram = useAsync(
    () => session?.role === "admin" ? api.telegramStatus(session) : Promise.resolve({ directConfigured: false, serviceReady: false, status: null }),
    [session?.token],
    { directConfigured: false, serviceReady: false, status: null } as TelegramIntegration
  );
  const [updating, setUpdating] = useState("");
  const [telegramBusy, setTelegramBusy] = useState("");
  const [error, setError] = useState("");
  const latestMedia = latest.data.filter((item) => item.type === "movie" || item.type === "series");
  const activeRequests = requests.data.filter((item) => item.status === "pending" || item.status === "approved");
  const fulfilledRequests = requests.data.filter((item) => item.status === "fulfilled");
  const rejectedRequests = requests.data.filter((item) => item.status === "rejected");

  useEffect(() => {
    if (session?.role !== "admin") return;
    const refresh = () => requests.reload().catch(() => undefined);
    const timer = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [session?.token, session?.role]);

  async function update(item: MediaRequest, status: RequestStatus) {
    if (!session) return;
    setUpdating(item.id);
    setError("");
    try {
      await api.updateRequest(session, item.id, status);
      await requests.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUpdating("");
    }
  }

  async function telegramAction(action: "test" | "start" | "stop" | "scan" | "menu") {
    if (!session) return;
    setTelegramBusy(action);
    setError("");
    try {
      if (action === "test") await api.telegramTest(session);
      else await api.telegramAction(session, action);
      await telegram.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTelegramBusy("");
    }
  }

  if (session?.role !== "admin") {
    return <section className="panel"><div className="notice">仅管理员可以访问管理后台。</div></section>;
  }

  return (
    <section className="panel adminPanel">
      <div className="sectionHead">
        <div>
          <h1>管理后台</h1>
          <p>入库动态与求片申请</p>
        </div>
      </div>
      {error || requests.error || latest.error || telegram.error ? <div className="notice">{error || requests.error || latest.error || telegram.error}</div> : null}
      <div className="adminSection settingsSection">
        <AdminSettingsForm session={session} onSaved={() => {
          onConfigChange();
          telegram.reload().catch(() => undefined);
        }} />
      </div>
      <div className="adminSection">
        <div className="subhead">
          <h2>Telegram 通知</h2>
          <span>{telegram.data.status?.version ? `TFEmby Web v${telegram.data.status.version}` : "TFEmby Web"}</span>
        </div>
        <div className="telegramCard">
          <div className="telegramIcon"><Bot size={27} /></div>
          <div className="telegramBody">
            <div className="telegramTitle">
              <strong>通知机器人</strong>
              <span className={`connectionDot ${telegram.data.serviceReady ? "online" : ""}`} />
              <span>{telegram.data.serviceReady ? (telegram.data.status?.running ? "扫描运行中" : "通知服务在线") : "服务异常"}</span>
            </div>
            <div className="telegramMeta">
              <span>{telegram.data.directConfigured ? "求片通知已配置" : "未配置 Bot Token / Chat ID"}</span>
              {telegram.data.status?.telegramRunning ? <span>Telegram 菜单监听中</span> : null}
              {telegram.data.status?.menuReady ? <span>命令菜单已同步</span> : null}
              {telegram.data.status?.lastMenuError ? <span>菜单异常：{telegram.data.status.lastMenuError}</span> : null}
              {telegram.data.status?.seenCount !== undefined ? <span>已记录 {telegram.data.status.seenCount}</span> : null}
              {telegram.data.status?.lastSummary ? <span>{telegram.data.status.lastSummary}</span> : null}
            </div>
          </div>
          <div className="telegramActions">
            <button className="softBtn" disabled={!telegram.data.directConfigured || Boolean(telegramBusy)} onClick={() => telegramAction("test")}>
              <BellRing size={16} />{telegramBusy === "test" ? "发送中" : "测试通知"}
            </button>
            <button className="softBtn" disabled={!telegram.data.directConfigured || Boolean(telegramBusy)} onClick={() => telegramAction("menu")}>
              <Send size={16} />{telegramBusy === "menu" ? "发送中" : "发送菜单"}
            </button>
            {telegram.data.status?.running ? (
              <button className="softBtn" disabled={Boolean(telegramBusy)} onClick={() => telegramAction("stop")}>{telegramBusy === "stop" ? "停止中" : "停止扫描"}</button>
            ) : (
              <button className="softBtn" disabled={!telegram.data.serviceReady || Boolean(telegramBusy)} onClick={() => telegramAction("start")}>{telegramBusy === "start" ? "启动中" : "启动扫描"}</button>
            )}
            <button className="softBtn" disabled={!telegram.data.serviceReady || Boolean(telegramBusy)} onClick={() => telegramAction("scan")}>{telegramBusy === "scan" ? "扫描中" : "立即扫描"}</button>
          </div>
        </div>
      </div>
      <div className="adminSection">
        <div className="subhead">
          <h2>求片处理中</h2>
          <span>{activeRequests.length} 条</span>
        </div>
        {!activeRequests.length && !requests.loading ? <div className="notice">暂无待处理或等待入库的求片。</div> : null}
        <div className="requestList">
          {activeRequests.map((item) => <RequestRow key={item.id} item={item} admin updating={updating === item.id} onStatus={(status) => update(item, status)} />)}
        </div>
      </div>
      <div className="adminSection requestArchiveSection">
        <div className="subhead">
          <h2>已入库</h2>
          <span>{fulfilledRequests.length} 条</span>
        </div>
        {!fulfilledRequests.length && !requests.loading ? <div className="notice">暂无已完成入库的求片。</div> : null}
        <div className="requestList">
          {fulfilledRequests.map((item) => <RequestRow key={item.id} item={item} admin />)}
        </div>
      </div>
      {rejectedRequests.length ? (
        <div className="adminSection requestArchiveSection">
          <div className="subhead">
            <h2>已拒绝</h2>
            <span>{rejectedRequests.length} 条</span>
          </div>
          <div className="requestList">
            {rejectedRequests.map((item) => <RequestRow key={item.id} item={item} admin />)}
          </div>
        </div>
      ) : null}
      <div className="adminSection">
        <div className="subhead">
          <h2>最近入库</h2>
          <span>{latestMedia.length} 项</span>
        </div>
        {!session.emby ? <div className="notice">请在左侧账户区域关联 Emby。</div> : null}
        {session.emby && !latestMedia.length && !latest.loading ? <div className="notice">暂无最近入库记录。</div> : null}
        <div className="grid latestPosterGrid">
          {latestMedia.map((item) => (
            <article className="mediaCard" key={item.id}>
              <Poster item={item} />
              <div className="mediaTitle" title={item.title}>{item.title}</div>
              <div className="metaLine"><span>{item.type === "movie" ? "电影" : item.type === "series" ? "剧集" : "单集"}</span><span>·</span><span>{formatDate(item.dateCreated)}</span></div>
              {item.recentEpisodeRange ? <div className="episodeRange cardEpisodeRange">{item.recentEpisodeRange}</div> : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function App() {
  const [config, setConfig] = useState<AppConfig>();
  const [session, setSession] = useState<UserSession | null>(() => loadSession());
  const [view, setView] = useState<View>("charts");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const refreshToken = useMemo(() => Date.now(), [view]);
  const embySession = session?.emby || null;

  useEffect(() => {
    api.config().then(setConfig).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  function handleLogin(next: UserSession) {
    setSession(next);
    saveSession(next);
    setView(next.role === "admin" ? "admin" : "overview");
    api.config().then(setConfig).catch(() => undefined);
  }

  function handleLogout() {
    setSession(null);
    saveSession(null);
  }

  return (
    <div className="appShell">
      <Sidebar view={view} setView={setView} open={sidebarOpen} setOpen={setSidebarOpen} config={config} session={session} onLogin={handleLogin} onLogout={handleLogout} />
      <main>
        <Topbar onMenu={() => setSidebarOpen(true)} dark={dark} setDark={setDark} onRefresh={() => setView((current) => current)} />
        <div className={`content ${view === "charts" ? "chartsContent" : view === "discover" ? "discoverContent" : ""}`} key={refreshToken}>
          {view === "overview" ? <Overview session={embySession} /> : null}
          {view === "charts" ? <ChartView session={embySession} /> : null}
          {view === "discover" ? <DiscoverView session={embySession} /> : null}
          {view === "search" ? <SearchView session={embySession} /> : null}
          {view === "resume" ? <TimelineView session={embySession} kind="resume" /> : null}
          {view === "latest" ? <TimelineView session={embySession} kind="latest" /> : null}
          {view === "requests" ? <RequestView session={session} /> : null}
          {view === "admin" ? <AdminView session={session} onConfigChange={() => api.config().then(setConfig).catch(() => undefined)} /> : null}
        </div>
      </main>
      <RequestStatusNotice session={session} />
    </div>
  );
}
