import {
  BadgePlus,
  BarChart3,
  BellRing,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clapperboard,
  ClipboardList,
  Copy,
  Flame,
  ExternalLink,
  Eye,
  EyeOff,
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
import type { AdminSettings, AppConfig, ChartItem, EmbySession, MediaItem, MediaRequest, RequestStatus, TelegramIntegration, TgBotConfig, TvSeason, UserSession, WebSettings } from "./types";

type View = "overview" | "charts" | "search" | "resume" | "latest" | "requests" | "admin";

const navItems: { key: View; label: string; icon: ReactNode; adminOnly?: boolean }[] = [
  { key: "overview", label: "总览概况", icon: <BarChart3 size={22} /> },
  { key: "charts", label: "全网热榜", icon: <Flame size={22} /> },
  { key: "search", label: "片库搜索", icon: <Search size={22} /> },
  { key: "resume", label: "继续观看", icon: <PlaySquare size={22} /> },
  { key: "latest", label: "最近新增", icon: <BadgePlus size={22} /> },
  { key: "requests", label: "求片申请", icon: <ClipboardList size={22} /> },
  { key: "admin", label: "管理后台", icon: <Settings size={22} />, adminOnly: true }
];

const requestStatus: Record<RequestStatus, string> = {
  pending: "待处理",
  approved: "已接收",
  fulfilled: "已入库",
  rejected: "已拒绝"
};

const chartOptions = [
  { label: "TMDB 全球趋势", source: "tmdb", chart: "global", media: "all", period: "week", icon: <Flame size={18} /> },
  { label: "TMDB 热门电影", source: "tmdb", chart: "movie-popular", media: "movie", period: "week", icon: <Clapperboard size={18} /> },
  { label: "TMDB 热门剧集", source: "tmdb", chart: "tv-popular", media: "tv", period: "week", icon: <Tv size={18} /> },
  { label: "TMDB 高分电影", source: "tmdb", chart: "movie-top-rated", media: "movie", period: "week", icon: <Star size={18} /> },
  { label: "TMDB 高分剧集", source: "tmdb", chart: "tv-top-rated", media: "tv", period: "week", icon: <Star size={18} /> },
  { label: "影院热映", source: "tmdb", chart: "now-playing", media: "movie", period: "week", icon: <Clapperboard size={18} /> },
  { label: "TMDB 电影月榜", source: "tmdb", chart: "monthly", media: "movie", period: "month", icon: <Library size={18} /> },
  { label: "TMDB 剧集月榜", source: "tmdb", chart: "monthly", media: "tv", period: "month", icon: <Library size={18} /> },
  { label: "豆瓣电影周榜", source: "douban", chart: "weekly", media: "movie", period: "week", icon: <Flame size={18} /> },
  { label: "豆瓣剧集周榜", source: "douban", chart: "weekly", media: "tv", period: "week", icon: <Tv size={18} /> },
  { label: "豆瓣电影月榜", source: "douban", chart: "monthly", media: "movie", period: "month", icon: <Library size={18} /> },
  { label: "豆瓣剧集月榜", source: "douban", chart: "monthly", media: "tv", period: "month", icon: <Library size={18} /> },
  { label: "豆瓣 TOP250", source: "douban", chart: "top250", media: "movie", period: "all", icon: <Star size={18} /> }
];

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
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function Poster({ item, compact = false }: { item: MediaItem | ChartItem | MediaRequest; compact?: boolean }) {
  const title = "title" in item ? item.title : "";
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.poster]);
  return (
    <div className={`poster ${compact ? "posterCompact" : ""}`}>
      {item.poster && !failed ? <img src={item.poster} alt={title} loading="lazy" onError={() => setFailed(true)} /> : <div className="posterFallback">{title.slice(0, 4)}</div>}
    </div>
  );
}

function ChartCard({ item, onOpen }: { item: ChartItem; onOpen: () => void }) {
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
      <div className="rank">#{item.rank}</div>
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

function ChartDetail({ item, onClose }: { item: ChartItem | null; onClose: () => void }) {
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

  if (!item) return null;
  const status = item.libraryStatus;
  const tmdbId = item.externalIds.tmdb;
  const doubanId = item.externalIds.douban;
  const tmdbUrl = tmdbId && /^\d+$/.test(tmdbId) ? `https://www.themoviedb.org/${item.mediaType}/${tmdbId}` : "";
  const doubanUrl = doubanId && /^\d+$/.test(doubanId) ? `https://movie.douban.com/subject/${doubanId}/` : "";

  return (
    <div className="detailOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="detailModal" role="dialog" aria-modal="true" aria-label={`${item.title}详情`}>
        <button className="detailClose" onClick={onClose} title="关闭详情" aria-label="关闭详情"><X size={21} /></button>
        <div className="detailVisual">
          {item.backdrop || item.poster ? <img className="detailBackdrop" src={item.backdrop || item.poster} alt="" /> : <div className="detailBackdrop detailBackdropFallback" />}
          <div className="detailShade" />
          <div className="detailHeading">
            <div className="detailPoster"><Poster item={item} /></div>
            <div className="detailTitleBlock">
              <div className="detailBadges">
                <span>{item.mediaType === "tv" ? "剧集" : "电影"}</span>
                <span>{item.source === "tmdb" ? "TMDB" : item.source === "douban" ? "豆瓣" : "热榜"}</span>
                {status?.inLibrary ? <span className="inLibraryBadge"><CheckCircle2 size={13} />已入库</span> : null}
              </div>
              <h1>{item.title}</h1>
              {item.originalTitle && item.originalTitle !== item.title ? <p>{item.originalTitle}</p> : null}
            </div>
          </div>
        </div>
        <div className="detailContent">
          <div className="detailFacts">
            <div><span>评分</span><strong><Star size={16} fill="currentColor" />{item.voteAverage ? item.voteAverage.toFixed(1) : "暂无"}</strong></div>
            <div><span>年份</span><strong>{item.year || "未知"}</strong></div>
            <div><span>上映日期</span><strong>{item.releaseDate || "未知"}</strong></div>
            <div><span>入库状态</span><strong>{status?.inLibrary ? "已入库" : "未入库"}</strong></div>
          </div>
          <div className="detailOverview">
            <h2>简介</h2>
            <p>{item.overview || "暂无简介。"}</p>
          </div>
          <div className="detailFooter">
            <div className="detailIds">
              {tmdbId ? <span>TMDB ID {tmdbId}</span> : null}
              {doubanId ? <span>豆瓣 ID {doubanId}</span> : null}
              {item.externalIds.imdb ? <span>IMDb {item.externalIds.imdb}</span> : null}
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

function MediaRow({ item }: { item: MediaItem }) {
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
    <article className="rowItem">
      <Poster item={item} compact />
      <div className="rowBody">
        <div className="rowTop">
          <strong title={displayTitle}>{displayTitle}</strong>
          <span>{item.year || formatDate(item.dateCreated || item.userData?.lastPlayedDate)}</span>
        </div>
        <div className="muted">{displayMeta}</div>
        {item.recentEpisodeRange ? <div className="episodeRange">{item.recentEpisodeRange}</div> : null}
        {item.userData?.progressPercent ? (
          <div className="progress">
            <span style={{ width: `${item.userData.progressPercent}%` }} />
          </div>
        ) : null}
      </div>
    </article>
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
          <div className="buildTag">TFEmby Web v{config?.version || "0.6.3"}</div>
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

function ChartView({ session }: { session: EmbySession | null }) {
  const [selected, setSelected] = useState(chartOptions[0]);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ChartItem | null>(null);
  const { data, loading, error } = useAsync(
    () => api.chart(selected.source, selected.chart, selected.media, selected.period, session),
    [selected, session?.accessToken],
    [] as ChartItem[]
  );

  return (
    <section className="panel">
      <div className="sectionHead">
        <div>
          <h1>全网热榜</h1>
          <p>近期大家都在看什么</p>
        </div>
        <div className="selectWrap">
          <button className="selectBtn" onClick={() => setOpen(!open)}>
            {selected.icon}
            <span>{selected.label}</span>
            <ChevronDown size={17} />
          </button>
          {open ? (
            <div className="menuList">
              {chartOptions.map((option) => (
                <button
                  key={`${option.source}-${option.chart}-${option.media}-${option.period}`}
                  onClick={() => {
                    setSelected(option);
                    setOpen(false);
                  }}
                >
                  {option.icon}
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {error ? <div className="notice">{error}</div> : null}
      {loading ? <div className="loadingGrid" /> : <div className="grid">{data.map((item) => <ChartCard key={`${item.source}-${item.rank}-${item.title}`} item={item} onOpen={() => setDetail(item)} />)}</div>}
      <ChartDetail item={detail} onClose={() => setDetail(null)} />
    </section>
  );
}

function Overview({ session }: { session: EmbySession | null }) {
  const stats = useAsync(() => (session ? api.stats(session) : Promise.resolve({ movies: 0, series: 0, played: 0, resume: 0, latest: 0 })), [session?.accessToken], {
    movies: 0,
    series: 0,
    played: 0,
    resume: 0,
    latest: 0
  });
  const resume = useAsync(() => (session ? api.resume(session) : Promise.resolve([])), [session?.accessToken], [] as MediaItem[]);
  const latest = useAsync(() => (session ? api.latest(session) : Promise.resolve([])), [session?.accessToken], [] as MediaItem[]);

  return (
    <section className="overview">
      <div className="stats">
        <div><strong>{stats.data.movies}</strong><span>电影</span></div>
        <div><strong>{stats.data.series}</strong><span>剧集</span></div>
        <div><strong>{stats.data.played}</strong><span>已看</span></div>
        <div><strong>{stats.data.resume}</strong><span>进度</span></div>
      </div>
      {!session ? <div className="notice">登录 Emby 后显示库内资源、播放历史和榜单观看状态。</div> : null}
      <div className="split">
        <section className="listPanel">
          <h2>继续观看</h2>
          {resume.data.slice(0, 5).map((item) => <MediaRow key={item.id} item={item} />)}
        </section>
        <section className="listPanel">
          <h2>最近入库</h2>
          {latest.data.slice(0, 5).map((item) => <MediaRow key={item.id} item={item} />)}
        </section>
      </div>
    </section>
  );
}

function SearchView({ session }: { session: EmbySession | null }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MediaItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session || !query.trim()) return;
    setBusy(true);
    setError("");
    try {
      setResults(await api.search(session, query.trim()));
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
          <p>查询库中电影、剧集与单集</p>
        </div>
      </div>
      <form className="searchBar" onSubmit={submit}>
        <Search size={20} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入片名" disabled={!session} />
        <button disabled={!session || busy}>{busy ? "搜索中" : "搜索"}</button>
      </form>
      {error ? <div className="notice">{error}</div> : null}
      {!session ? <div className="notice">请先登录 Emby。</div> : null}
      <div className="rows">{results.map((item) => <MediaRow key={item.id} item={item} />)}</div>
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
          <span>TMDB {item.tmdbId}</span>
          {item.year ? <span>{item.year}</span> : null}
          {admin ? <span>申请人：{item.requestedBy.username}</span> : null}
          <span>{formatDate(item.createdAt)}</span>
        </div>
        {admin && onStatus ? (
          <select className="statusSelect" value={item.status} disabled={updating} onChange={(event) => onStatus(event.target.value as RequestStatus)} aria-label={`更新 ${item.title} 的申请状态`}>
            {Object.entries(requestStatus).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        ) : null}
      </div>
    </article>
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
  const requests = useAsync(() => (session ? api.requests(session) : Promise.resolve([])), [session?.token], [] as MediaRequest[]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!session || !query.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setResults(await api.searchTmdb(session, query.trim()));
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
      {session && requests.data.length ? (
        <div className="requestSection">
          <h2>我的申请</h2>
          <div className="requestList">{requests.data.map((item) => <RequestRow key={item.id} item={item} />)}</div>
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
          <span>配置保存在数据卷中，保存后立即生效</span>
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
        <div className="settingsTestRow">
          <button type="button" className="softBtn" disabled={Boolean(busy)} onClick={() => test("telegram")}><TestTube2 size={16} />{busy === "telegram" ? "测试中" : "测试 Telegram"}</button>
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

  async function telegramAction(action: "test" | "start" | "stop" | "scan") {
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
              {telegram.data.status?.seenCount !== undefined ? <span>已记录 {telegram.data.status.seenCount}</span> : null}
              {telegram.data.status?.lastSummary ? <span>{telegram.data.status.lastSummary}</span> : null}
            </div>
          </div>
          <div className="telegramActions">
            <button className="softBtn" disabled={!telegram.data.directConfigured || Boolean(telegramBusy)} onClick={() => telegramAction("test")}>
              <BellRing size={16} />{telegramBusy === "test" ? "发送中" : "测试通知"}
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
      <div className="adminSection">
        <div className="subhead">
          <h2>求片申请</h2>
          <span>{requests.data.length} 条</span>
        </div>
        {!requests.data.length && !requests.loading ? <div className="notice">暂无求片申请。</div> : null}
        <div className="requestList">
          {requests.data.map((item) => <RequestRow key={item.id} item={item} admin updating={updating === item.id} onStatus={(status) => update(item, status)} />)}
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
        <div className="content" key={refreshToken}>
          {view === "overview" ? <Overview session={embySession} /> : null}
          {view === "charts" ? <ChartView session={embySession} /> : null}
          {view === "search" ? <SearchView session={embySession} /> : null}
          {view === "resume" ? <TimelineView session={embySession} kind="resume" /> : null}
          {view === "latest" ? <TimelineView session={embySession} kind="latest" /> : null}
          {view === "requests" ? <RequestView session={session} /> : null}
          {view === "admin" ? <AdminView session={session} onConfigChange={() => api.config().then(setConfig).catch(() => undefined)} /> : null}
        </div>
      </main>
    </div>
  );
}
