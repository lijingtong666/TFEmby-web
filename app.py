#!/usr/bin/env python3
import html
import ipaddress
import json
import os
import posixpath
import re
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = ROOT / "data"
CONFIG_PATH = DATA_DIR / "config.json"
STATE_PATH = DATA_DIR / "state.json"
APP_VERSION = os.environ.get("APP_VERSION", "1.1.6")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("WEBHOOK_PORT") or os.environ.get("PORT") or "8099")

DEFAULT_CONFIG = {
    "telegramBotToken": "",
    "telegramChatId": "",
    "tmdbApiKey": "",
    "tmdbLanguage": "zh-CN",
    "embyUrl": "",
    "embyApiKey": "",
    "embyUserId": "",
    "publicBaseUrl": "",
    "webhookSecret": "",
    "doubanFallbackEnabled": True,
    "enableCovers": True,
    "overviewMaxLength": 420,
    "monitoredEvents": "library.new,item.added,item.created,itemadded",
    "includeTypes": ["Movie", "Episode"],
    "pollIntervalSeconds": 300,
    "latestLimit": 20,
    "notifyFirstRun": False,
    "proxyEnabled": False,
    "proxyUrl": "",
}

DEFAULT_STATE = {
    "seen": {},
    "telegramUpdateOffset": None,
    "lastScanAt": None,
    "lastWebhookAt": None,
    "lastError": "",
    "lastSummary": "",
}

LOG_LIMIT = 120
TEST_MESSAGE = "这是一条测试信息"
EMBY_ITEM_FIELDS = [
    "DateCreated",
    "ProviderIds",
    "Overview",
    "Genres",
    "ProductionYear",
    "PremiereDate",
    "CommunityRating",
    "OfficialRating",
    "RunTimeTicks",
    "SeriesId",
    "SeriesName",
    "ParentIndexNumber",
    "IndexNumber",
    "Path",
    "ProductionLocations",
    "MediaSources",
    "MediaStreams",
    "Size",
]
config_lock = threading.RLock()
state_lock = threading.RLock()
runtime_lock = threading.RLock()
stop_event = threading.Event()
telegram_stop_event = threading.Event()
poller_thread = None
telegram_thread = None
runtime = {
    "running": False,
    "telegramRunning": False,
    "lastTickAt": None,
    "logs": [],
}


class ApiError(Exception):
    def __init__(self, message, status=None, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


def ensure_data_dir():
    DATA_DIR.mkdir(exist_ok=True)
    if not CONFIG_PATH.exists():
        save_json(CONFIG_PATH, DEFAULT_CONFIG)
    if not STATE_PATH.exists():
        save_json(STATE_PATH, DEFAULT_STATE)


def load_json(path, default):
    try:
        with path.open("r", encoding="utf-8") as fh:
            value = json.load(fh)
    except FileNotFoundError:
        return dict(default)
    except json.JSONDecodeError:
        return dict(default)
    merged = dict(default)
    if isinstance(value, dict):
        merged.update(value)
    return merged


def save_json(path, value):
    path.parent.mkdir(exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(value, fh, ensure_ascii=False, indent=2)
    tmp.replace(path)


def get_config():
    with config_lock:
        return load_json(CONFIG_PATH, DEFAULT_CONFIG)


def save_config(config):
    cleaned = dict(DEFAULT_CONFIG)
    cleaned.update(config)
    cleaned["pollIntervalSeconds"] = clamp_int(cleaned.get("pollIntervalSeconds"), 60, 86400, 300)
    cleaned["latestLimit"] = clamp_int(cleaned.get("latestLimit"), 1, 100, 20)
    cleaned["overviewMaxLength"] = clamp_int(cleaned.get("overviewMaxLength"), 80, 2000, 420)
    cleaned["includeTypes"] = [
        item for item in cleaned.get("includeTypes", []) if item in {"Movie", "Episode", "Series"}
    ] or ["Movie", "Episode"]
    cleaned["notifyFirstRun"] = bool(cleaned.get("notifyFirstRun"))
    cleaned["proxyEnabled"] = bool(cleaned.get("proxyEnabled"))
    for key in [
        "telegramBotToken",
        "telegramChatId",
        "tmdbApiKey",
        "tmdbLanguage",
        "embyUrl",
        "embyApiKey",
        "embyUserId",
        "publicBaseUrl",
        "webhookSecret",
        "monitoredEvents",
        "proxyUrl",
    ]:
        cleaned[key] = str(cleaned.get(key, "")).strip()
    cleaned["doubanFallbackEnabled"] = bool(cleaned.get("doubanFallbackEnabled"))
    cleaned["enableCovers"] = bool(cleaned.get("enableCovers"))
    with config_lock:
        save_json(CONFIG_PATH, cleaned)
    return cleaned


def get_state():
    with state_lock:
        return load_json(STATE_PATH, DEFAULT_STATE)


def save_state(state):
    with state_lock:
        save_json(STATE_PATH, state)


def clamp_int(value, low, high, fallback):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, number))


def env_bool(name, default=None):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "y"}


def first_env(*names):
    for name in names:
        value = os.environ.get(name)
        if value not in (None, ""):
            return value.strip()
    return ""


def apply_env_config():
    env_config = {}
    mappings = {
        "telegramBotToken": ("TELEGRAM_BOT_TOKEN", "TG_BOT_TOKEN"),
        "telegramChatId": ("TELEGRAM_CHAT_ID", "TG_CHAT_ID"),
        "tmdbApiKey": ("TMDB_API_KEY",),
        "tmdbLanguage": ("TMDB_LANGUAGE",),
        "embyUrl": ("EMBY_SERVER_URL", "EMBY_URL"),
        "embyApiKey": ("EMBY_API_KEY",),
        "embyUserId": ("EMBY_USER_ID",),
        "webhookSecret": ("WEBHOOK_SECRET",),
        "monitoredEvents": ("EMBY_MONITOR_EVENTS", "MONITORED_EVENTS"),
    }
    for key, names in mappings.items():
        value = first_env(*names)
        if value:
            env_config[key] = value

    public_base_url = first_env("PUBLIC_BASE_URL", "WEBHOOK_URL")
    webhook_host = first_env("WEBHOOK_HOST")
    webhook_port = first_env("WEBHOOK_PORT")
    if not public_base_url and webhook_host:
        public_base_url = f"http://{webhook_host}:{webhook_port or PORT}"
    if public_base_url:
        env_config["publicBaseUrl"] = public_base_url.rstrip("/")

    proxy_url = first_env("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy")
    if proxy_url:
        env_config["proxyEnabled"] = True
        env_config["proxyUrl"] = proxy_url

    enable_covers = env_bool("ENABLE_COVERS")
    if enable_covers is not None:
        env_config["enableCovers"] = enable_covers

    douban_fallback = env_bool("DOUBAN_FALLBACK_ENABLED")
    if douban_fallback is not None:
        env_config["doubanFallbackEnabled"] = douban_fallback

    overview_max_length = first_env("OVERVIEW_MAX_LENGTH")
    if overview_max_length:
        env_config["overviewMaxLength"] = overview_max_length

    if env_config:
        config = get_config()
        config.update(env_config)
        save_config(config)
        add_log(f"已加载环境变量配置：{', '.join(sorted(env_config.keys()))}")


def add_log(message):
    entry = {"at": now_iso(), "message": message}
    with runtime_lock:
        runtime["logs"].append(entry)
        del runtime["logs"][:-LOG_LIMIT]
    print(f"[{entry['at']}] {message}", flush=True)


def now_iso():
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def require_fields(config, fields):
    missing = [field for field in fields if not config.get(field)]
    if missing:
        labels = ", ".join(missing)
        raise ApiError(f"缺少配置：{labels}")


def host_in_no_proxy(host, no_proxy):
    host = (host or "").strip().lower().strip("[]")
    if not host:
        return False
    for raw_rule in str(no_proxy or "").split(","):
        rule = raw_rule.strip().lower()
        if not rule:
            continue
        if rule == "*":
            return True
        if "/" in rule:
            try:
                if ipaddress.ip_address(host) in ipaddress.ip_network(rule, strict=False):
                    return True
            except ValueError:
                pass
        if host == rule or host.endswith("." + rule.lstrip(".")):
            return True
    return False


def should_bypass_proxy(url, config):
    host = urllib.parse.urlparse(url).hostname or ""
    if host_in_no_proxy(host, os.environ.get("NO_PROXY") or os.environ.get("no_proxy")):
        return True
    if host_in_no_proxy(host, config.get("noProxy", "")):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return host.lower() in {"localhost", "host.docker.internal"}


def build_opener(config, url=None):
    if url and should_bypass_proxy(url, config):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    if config.get("proxyEnabled") and config.get("proxyUrl"):
        proxies = {"http": config["proxyUrl"], "https": config["proxyUrl"]}
        return urllib.request.build_opener(urllib.request.ProxyHandler(proxies))
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request_json(method, url, config, params=None, payload=None, headers=None, timeout=20):
    if params:
        query = urllib.parse.urlencode(params, doseq=True)
        joiner = "&" if urllib.parse.urlparse(url).query else "?"
        url = f"{url}{joiner}{query}"
    body = None
    request_headers = {"Accept": "application/json"}
    if headers:
        request_headers.update(headers)
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(url, data=body, method=method, headers=request_headers)
    opener = build_opener(config, url)
    try:
        with opener.open(req, timeout=timeout) as response:
            raw = response.read()
            if not raw:
                return None
            text = raw.decode("utf-8", errors="replace")
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return {"raw": text}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise ApiError(f"HTTP {exc.code}: {url}", status=exc.code, body=raw[:600]) from exc
    except urllib.error.URLError as exc:
        raise ApiError(f"请求失败：{exc.reason}") from exc
    except TimeoutError as exc:
        raise ApiError(f"请求超时：{url}") from exc
    except OSError as exc:
        raise ApiError(f"请求失败：{exc}") from exc


def request_text(method, url, config, params=None, headers=None, timeout=20):
    if params:
        query = urllib.parse.urlencode(params, doseq=True)
        joiner = "&" if urllib.parse.urlparse(url).query else "?"
        url = f"{url}{joiner}{query}"
    request_headers = {
        "Accept": "text/html,application/json",
        "User-Agent": "Mozilla/5.0 TG-Emby-Notify/1.0",
    }
    if headers:
        request_headers.update(headers)
    req = urllib.request.Request(url, method=method, headers=request_headers)
    opener = build_opener(config, url)
    try:
        with opener.open(req, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise ApiError(f"HTTP {exc.code}: {url}", status=exc.code, body=raw[:600]) from exc
    except urllib.error.URLError as exc:
        raise ApiError(f"请求失败：{exc.reason}") from exc
    except TimeoutError as exc:
        raise ApiError(f"请求超时：{url}") from exc
    except OSError as exc:
        raise ApiError(f"请求失败：{exc}") from exc


def request_form(method, url, config, form, timeout=20):
    body = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/x-www-form-urlencoded; charset=utf-8"},
    )
    opener = build_opener(config, url)
    try:
        with opener.open(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        detail = raw[:600]
        try:
            detail = telegram_error_detail(json.loads(raw))
        except Exception:
            pass
        raise ApiError(f"Telegram HTTP {exc.code}: {detail}", status=exc.code, body=raw[:600]) from exc
    except urllib.error.URLError as exc:
        raise ApiError(f"Telegram 请求失败：{exc.reason}") from exc
    except TimeoutError as exc:
        raise ApiError(f"Telegram 请求超时：{url}") from exc
    except OSError as exc:
        raise ApiError(f"Telegram 请求失败：{exc}") from exc


def emby_base(config):
    base = config.get("embyUrl", "").strip().rstrip("/")
    if not base:
        raise ApiError("缺少 Emby URL")
    if not urllib.parse.urlparse(base).scheme:
        base = "http://" + base
    return base


def emby_get(config, path, params=None):
    require_fields(config, ["embyUrl", "embyApiKey"])
    path = path.lstrip("/")
    params = dict(params or {})
    params.setdefault("api_key", config["embyApiKey"])
    headers = {"X-Emby-Token": config["embyApiKey"]}
    base = emby_base(config)
    candidates = [f"{base}/{path}"]
    if not path.startswith("emby/"):
        candidates.append(f"{base}/emby/{path}")
    last_error = None
    for url in candidates:
        try:
            return request_json("GET", url, config, params=params, headers=headers)
        except ApiError as exc:
            last_error = exc
            if exc.status not in (404, 405):
                break
    raise last_error or ApiError("Emby 请求失败")


def tmdb_get(config, path, params=None):
    require_fields(config, ["tmdbApiKey"])
    query = {
        "api_key": config["tmdbApiKey"],
        "language": config.get("tmdbLanguage") or "zh-CN",
    }
    query.update(params or {})
    url = "https://api.themoviedb.org/3/" + path.lstrip("/")
    return request_json("GET", url, config, params=query)


def get_latest_items(config):
    include_types = ",".join(config.get("includeTypes") or ["Movie", "Episode"])
    fields = ",".join(EMBY_ITEM_FIELDS)
    params = {
        "Limit": config.get("latestLimit", 20),
        "IncludeItemTypes": include_types,
        "Fields": fields,
        "EnableImages": "true",
    }
    user_id = config.get("embyUserId")
    if user_id:
        return emby_get(config, f"Users/{urllib.parse.quote(user_id)}/Items/Latest", params=params)
    try:
        users = emby_get(config, "Users")
        if isinstance(users, list) and users:
            first_user = users[0].get("Id")
            if first_user:
                add_log(f"未配置 Emby User ID，自动使用用户：{users[0].get('Name') or first_user}")
                return emby_get(config, f"Users/{urllib.parse.quote(first_user)}/Items/Latest", params=params)
    except Exception as exc:
        add_log(f"自动获取 Emby 用户失败，改用全局最新项目接口：{exc}")
    return emby_get(config, "Items/Latest", params=params)


def test_emby(config):
    info = emby_get(config, "System/Info")
    server_name = info.get("ServerName") or info.get("LocalAddress") or "Emby"
    version = info.get("Version") or "unknown"
    return f"Emby 连接成功：{server_name} / {version}"


def test_tmdb(config):
    result = tmdb_get(config, "configuration")
    base_url = result.get("images", {}).get("secure_base_url", "")
    return f"TMDB 连接成功：{base_url or 'configuration ok'}"


def test_douban(config):
    result = douban_lookup(config, {"Name": "流浪地球", "Type": "Movie"})
    return f"豆瓣备用连接成功：{result.get('title') or '可访问'}"


def test_telegram(config):
    sent = send_telegram_text(config, TEST_MESSAGE)
    return f"Telegram 测试消息已发送：{sent} 个会话"


def telegram_error_detail(result):
    if isinstance(result, dict):
        description = result.get("description")
        error_code = result.get("error_code")
        if description:
            return f"{error_code or 'error'} / {description}"
    return str(result)


def send_telegram_text(config, text):
    require_fields(config, ["telegramBotToken", "telegramChatId"])
    url = f"https://api.telegram.org/bot{config['telegramBotToken']}/sendMessage"
    sent = 0
    for chat_id in parse_chat_ids(config["telegramChatId"]):
        result = request_form(
            "POST",
            url,
            config,
            {"chat_id": chat_id, "text": text},
        )
        if not result or not result.get("ok"):
            raise ApiError(f"Telegram 返回异常：chat_id={chat_id} / {telegram_error_detail(result)}")
        sent += 1
    return sent


def send_telegram_text_to_chat(config, chat_id, text, reply_to_message_id=None):
    require_fields(config, ["telegramBotToken"])
    url = f"https://api.telegram.org/bot{config['telegramBotToken']}/sendMessage"
    payload = {
        "chat_id": str(chat_id),
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    }
    if reply_to_message_id:
        payload["reply_to_message_id"] = reply_to_message_id
    result = request_form("POST", url, config, payload)
    if not result or not result.get("ok"):
        raise ApiError(f"Telegram 返回异常：chat_id={chat_id} / {telegram_error_detail(result)}")
    return result


def telegram_json(config, method, payload=None, timeout=35):
    token = config.get("telegramBotToken", "")
    if not token:
        raise ApiError("缺少配置：telegramBotToken")
    url = f"https://api.telegram.org/bot{token}/{method}"
    try:
        return request_json("POST", url, config, payload=payload or {}, timeout=timeout)
    except ApiError as exc:
        message = str(exc).replace(token, "[token]")
        body = exc.body.replace(token, "[token]") if isinstance(exc.body, str) else exc.body
        raise ApiError(message, status=exc.status, body=body) from exc


def setup_telegram_commands(config):
    commands = [
        {"command": "recent", "description": "最近入库"},
        {"command": "start", "description": "开始使用"},
        {"command": "help", "description": "使用说明"},
    ]
    result = telegram_json(config, "setMyCommands", {"commands": commands}, timeout=15)
    if not result or not result.get("ok"):
        raise ApiError(f"Telegram 菜单设置失败：{telegram_error_detail(result)}")
    return True


def tmdb_image_url(path):
    if not path:
        return ""
    return f"https://image.tmdb.org/t/p/w500{path}"


def parse_chat_ids(value):
    chat_ids = [part.strip() for part in str(value or "").split(",") if part.strip()]
    if not chat_ids:
        raise ApiError("缺少配置：telegramChatId")
    return chat_ids


def first_value(source, names):
    if not isinstance(source, dict):
        return ""
    lower_map = {str(key).lower(): value for key, value in source.items()}
    for name in names:
        value = source.get(name)
        if value not in (None, ""):
            return value
        value = lower_map.get(name.lower())
        if value not in (None, ""):
            return value
    return ""


def find_nested_value(source, names):
    if isinstance(source, dict):
        value = first_value(source, names)
        if value not in (None, ""):
            return value
        for child in source.values():
            found = find_nested_value(child, names)
            if found not in (None, ""):
                return found
    elif isinstance(source, list):
        for child in source:
            found = find_nested_value(child, names)
            if found not in (None, ""):
                return found
    return ""


def html_unescape_text(value):
    return html.unescape(re.sub(r"\s+", " ", value or "")).strip()


def enrich_with_tmdb(config, item):
    provider_ids = item.get("ProviderIds") or {}
    item_type = item.get("Type", "")
    tmdb_id = provider_ids.get("Tmdb")
    language = config.get("tmdbLanguage") or "zh-CN"
    media_kind = "movie" if item_type == "Movie" else "tv"
    try:
        if tmdb_id:
            return tmdb_get(
                config,
                f"{media_kind}/{tmdb_id}",
                params={"append_to_response": "external_ids", "language": language},
            )
        query = item.get("SeriesName") if item_type == "Episode" else item.get("Name")
        if not query:
            return {}
        search_path = "search/movie" if item_type == "Movie" else "search/tv"
        params = {"query": query, "language": language}
        if item.get("ProductionYear") and item_type == "Movie":
            params["year"] = item["ProductionYear"]
        result = tmdb_get(config, search_path, params=params)
        matches = result.get("results") or []
        return matches[0] if matches else {}
    except Exception as exc:
        add_log(f"TMDB 补充失败：{item.get('Name', '未知项目')} - {exc}")
        return {}


def douban_lookup(config, item):
    query = item.get("SeriesName") if item.get("Type") == "Episode" else item.get("Name")
    if not query:
        return {}
    try:
        text = request_text(
            "GET",
            "https://movie.douban.com/j/subject_suggest",
            config,
            params={"q": query},
            timeout=12,
        )
        candidates = json.loads(text)
        if not isinstance(candidates, list) or not candidates:
            return {}
        chosen = candidates[0]
        detail = {}
        if chosen.get("url"):
            try:
                page = request_text("GET", chosen["url"], config, timeout=12)
                description = ""
                match = re.search(
                    r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']',
                    page,
                    re.IGNORECASE,
                )
                if match:
                    description = html_unescape_text(match.group(1))
                detail["overview"] = description
                rating_match = re.search(r'<strong[^>]+class=["\']ll\s+rating_num["\'][^>]*>([^<]+)</strong>', page)
                if not rating_match:
                    rating_match = re.search(r'"ratingValue"\s*:\s*"?(\d+(?:\.\d+)?)"?', page)
                if rating_match:
                    detail["rating"] = html_unescape_text(rating_match.group(1))
            except Exception as exc:
                add_log(f"豆瓣详情页读取失败：{query} - {exc}")
        return {
            "source": "douban",
            "id": chosen.get("id"),
            "title": chosen.get("title"),
            "year": chosen.get("year"),
            "poster": chosen.get("img"),
            "url": chosen.get("url"),
            "overview": detail.get("overview") or chosen.get("sub_title") or "",
            "rating": detail.get("rating") or chosen.get("rating") or chosen.get("rate") or "",
        }
    except Exception as exc:
        add_log(f"豆瓣备用补充失败：{query} - {exc}")
        return {}


def build_metadata(config, item):
    tmdb = enrich_with_tmdb(config, item) if config.get("tmdbApiKey") else {}
    douban = {}
    if config.get("doubanFallbackEnabled"):
        douban = douban_lookup(config, item)
    return {"tmdb": tmdb, "douban": douban}


def emby_item_url(config, item_id):
    base = emby_base(config)
    return f"{base}/web/index.html#!/item?id={urllib.parse.quote(str(item_id))}"


def format_item_title(item):
    item_type = item.get("Type", "")
    name = item.get("Name") or "未命名"
    if item_type == "Episode":
        series = item.get("SeriesName") or name
        season = item.get("ParentIndexNumber")
        episode = item.get("IndexNumber")
        if season is not None and episode is not None:
            return f"{series} S{int(season):02d}E{int(episode):02d} - {name}"
        return f"{series} - {name}"
    return name


def parse_emby_time(raw):
    if not raw:
        return None
    value = str(raw).strip()
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def compact_time(raw):
    if not raw:
        return ""
    return str(raw).replace("T", " ").replace("Z", "").split(".")[0]


def event_time_raw(item, webhook_data=None):
    webhook_data = webhook_data or {}
    return (
        find_nested_value(webhook_data, ["Date", "TimeStamp", "Timestamp", "ItemDateAdded"])
        or item.get("_WebhookReceivedAt")
        or item.get("DateCreated")
        or item.get("DateAdded")
        or find_nested_value(webhook_data, ["DateCreated", "DateAdded"])
    )


def format_event_time(item, webhook_data=None):
    value = compact_time(event_time_raw(item, webhook_data)) or now_iso()
    return value[:16] if len(value) >= 16 else value


def coerce_int(value):
    try:
        if value in (None, ""):
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def episode_sort_key(item):
    return (
        coerce_int(item.get("ParentIndexNumber")) or 0,
        coerce_int(item.get("IndexNumber")) or 0,
        item.get("Name") or "",
    )


def format_episode_token(season, episode):
    if season is None or episode is None:
        return ""
    return f"S{season:02d}E{episode:02d}"


def format_episode_range(episodes):
    cleaned = [item for item in episodes or [] if item.get("Type") == "Episode"]
    if not cleaned:
        return ""
    cleaned = sorted(cleaned, key=episode_sort_key)
    groups = {}
    for episode in cleaned:
        season = coerce_int(episode.get("ParentIndexNumber"))
        index = coerce_int(episode.get("IndexNumber"))
        if season is None or index is None:
            continue
        groups.setdefault(season, []).append(index)
    if not groups:
        return f"(共{len(cleaned)}集)"
    parts = []
    for season in sorted(groups):
        indexes = sorted(set(groups[season]))
        if len(indexes) == 1:
            parts.append(format_episode_token(season, indexes[0]))
        elif indexes == list(range(indexes[0], indexes[-1] + 1)):
            parts.append(f"{format_episode_token(season, indexes[0])}-E{indexes[-1]:02d}")
        else:
            tokens = ",".join(f"E{index:02d}" for index in indexes)
            parts.append(f"S{season:02d}{tokens}")
    return f"{', '.join(parts)} (共{len(cleaned)}集)"


def media_streams(item):
    streams = []
    for source in item.get("MediaSources") or []:
        streams.extend(source.get("MediaStreams") or [])
    streams.extend(item.get("MediaStreams") or [])
    return streams


def video_stream(item):
    for stream in media_streams(item):
        if str(stream.get("Type") or "").lower() == "video":
            return stream
    return {}


def first_media_source(item):
    sources = item.get("MediaSources")
    if isinstance(sources, list) and sources:
        return sources[0] or {}
    return {}


def quality_label(item):
    source = first_media_source(item)
    stream = video_stream(item)
    height = coerce_int(stream.get("Height") or source.get("Height"))
    width = coerce_int(stream.get("Width") or source.get("Width"))
    if (height and height >= 2160) or (width and width >= 3800):
        return "4K"
    if height and height >= 1440:
        return "2K"
    if height and height >= 1080:
        return "1080P"
    if height and height >= 720:
        return "720P"
    return "N/A"


def hdr_label(item):
    source = first_media_source(item)
    stream = video_stream(item)
    values = [
        stream.get("VideoRange"),
        stream.get("VideoRangeType"),
        stream.get("Profile"),
        stream.get("ColorTransfer"),
        source.get("VideoRange"),
        source.get("VideoRangeType"),
    ]
    joined = " ".join(str(value) for value in values if value).lower()
    if any(marker in joined for marker in ("dolby vision", "dovi", "dv")):
        return "DV"
    if any(marker in joined for marker in ("hdr10", "hdr", "hlg")):
        return "HDR"
    return ""


def quality_tags(item):
    tags = []
    quality = quality_label(item)
    if quality != "N/A":
        tags.append(quality)
    hdr = hdr_label(item)
    if hdr:
        tags.append(hdr)
    return " ".join(f"[{tag}]" for tag in tags) if tags else "N/A"


def codec_label(item):
    source = first_media_source(item)
    stream = video_stream(item)
    codec = str(stream.get("Codec") or source.get("VideoCodec") or source.get("Codec") or "").strip()
    if not codec:
        return "N/A"
    mapping = {"hevc": "HEVC", "h265": "HEVC", "h.265": "HEVC", "h264": "H.264", "h.264": "H.264", "av1": "AV1"}
    return mapping.get(codec.lower(), codec.upper())


def rating_label(value):
    if value in (None, "", 0, "0"):
        return "N/A"
    try:
        return f"{float(value):.1f}"
    except (TypeError, ValueError):
        return str(value)


def numeric_rating(value):
    if value in (None, "", 0, "0"):
        return None
    try:
        number = float(value)
        return number if number > 0 else None
    except (TypeError, ValueError):
        return None


def best_rating(item, metadata):
    tmdb = metadata.get("tmdb") or {}
    douban = metadata.get("douban") or {}
    values = [
        numeric_rating(tmdb.get("vote_average")),
        numeric_rating(douban.get("rating")),
        numeric_rating(item.get("CommunityRating")),
    ]
    values = [value for value in values if value is not None]
    return max(values) if values else None


def best_rating_label(item, metadata):
    value = best_rating(item, metadata)
    return "N/A" if value is None else f"{value:.1f}"


def country_candidates(item, tmdb):
    values = []
    values.extend(item.get("ProductionLocations") or [])
    values.extend(tmdb.get("origin_country") or [])
    for country in tmdb.get("production_countries") or []:
        if isinstance(country, dict):
            values.append(country.get("iso_3166_1") or country.get("name"))
        else:
            values.append(country)
    return [str(value).strip() for value in values if str(value or "").strip()]


def region_prefix(item, metadata):
    tmdb = metadata.get("tmdb") or {}
    joined = " ".join(country_candidates(item, tmdb)).lower()
    country_map = [
        (("cn", "china", "中国", "mainland"), "国产"),
        (("hk", "hong kong", "香港", "tw", "taiwan", "台湾"), "港台"),
        (("us", "usa", "united states", "america", "美国"), "美国"),
        (("jp", "japan", "日本"), "日本"),
        (("kr", "korea", "韩国", "south korea"), "韩国"),
        (("gb", "uk", "united kingdom", "英国"), "英国"),
        (("th", "thailand", "泰国"), "泰国"),
        (("in", "india", "印度"), "印度"),
        (("fr", "france", "法国"), "法国"),
        (("de", "germany", "德国"), "德国"),
        (("es", "spain", "西班牙"), "西班牙"),
    ]
    for markers, label in country_map:
        if any(marker in joined for marker in markers):
            return label
    values = country_candidates(item, tmdb)
    return values[0] if values else ""


def region_display(item, metadata):
    prefix = region_prefix(item, metadata)
    mapping = {
        "国产": "大陆",
        "港台": "港台",
        "美国": "美国",
        "日本": "日本",
        "韩国": "韩国",
        "英国": "英国",
        "泰国": "泰国",
        "印度": "印度",
        "法国": "法国",
        "德国": "德国",
    }
    return mapping.get(prefix, prefix or "N/A")


def media_kind_text(item):
    if item.get("Type") in ("Episode", "Series"):
        return "剧集"
    if item.get("Type") == "Movie":
        return "电影"
    return "媒体"


def typed_region_label(item, metadata):
    prefix = region_prefix(item, metadata)
    kind = media_kind_text(item)
    if not prefix:
        return kind
    if kind == "剧集":
        short = {"美国": "美", "日本": "日", "韩国": "韩", "英国": "英", "泰国": "泰", "法国": "法", "德国": "德"}
        return f"{short.get(prefix, prefix)}剧"
    if kind == "电影":
        return f"{prefix}电影"
    return f"{prefix}{kind}"


def display_title(item):
    if item.get("Type") == "Series":
        suffix = item.get("_EpisodeRange") or ""
        return f"{item.get('Name') or '未命名'} {suffix}".strip()
    if item.get("Type") == "Episode":
        series = item.get("SeriesName") or item.get("Name") or "未命名"
        suffix = format_episode_range([item])
        return f"{series} {suffix}".strip()
    return item.get("Name") or "未命名"


def sample_media_item(item):
    episodes = item.get("_RecentEpisodes") or []
    return episodes[0] if episodes else item


def genre_label(item, tmdb):
    genres = tmdb.get("genres") or []
    if genres and isinstance(genres[0], dict):
        return " / ".join(g.get("name", "") for g in genres[:4] if g.get("name"))
    return " / ".join((item.get("Genres") or [])[:4])


def topic_label(item, tmdb):
    genre = genre_label(item, tmdb)
    return genre or "N/A"


def year_label(item, tmdb, douban):
    return (
        item.get("ProductionYear")
        or tmdb.get("release_date", "")[:4]
        or tmdb.get("first_air_date", "")[:4]
        or douban.get("year")
        or (item.get("PremiereDate") or "")[:4]
        or "N/A"
    )


def tmdb_page_url(item, metadata):
    tmdb = metadata.get("tmdb") or {}
    provider_ids = item.get("ProviderIds") or {}
    tmdb_id = tmdb.get("id") or provider_ids.get("Tmdb")
    if not tmdb_id:
        return ""
    kind = "movie" if item.get("Type") == "Movie" else "tv"
    return f"https://www.themoviedb.org/{kind}/{tmdb_id}"


def tmdb_id_label(item, metadata):
    tmdb = metadata.get("tmdb") or {}
    provider_ids = item.get("ProviderIds") or {}
    return str(tmdb.get("id") or provider_ids.get("Tmdb") or "N/A")


def size_value(item):
    values = []
    for source in item.get("MediaSources") or []:
        values.append(source.get("Size"))
    values.append(item.get("Size"))
    for value in values:
        try:
            number = int(value)
            if number > 0:
                return number
        except (TypeError, ValueError):
            continue
    return 0


def total_size_value(item):
    episodes = item.get("_RecentEpisodes") or []
    if episodes:
        return sum(size_value(episode) for episode in episodes)
    return size_value(item)


def size_label(bytes_value):
    try:
        value = int(bytes_value)
    except (TypeError, ValueError):
        value = 0
    if value <= 0:
        return "N/A"
    units = ["B", "K", "M", "G", "T"]
    size = float(value)
    unit_index = 0
    while size >= 1024 and unit_index < len(units) - 1:
        size /= 1024
        unit_index += 1
    if unit_index == 0:
        return f"{int(size)}{units[unit_index]}"
    return f"{size:.2f}{units[unit_index]}"


def format_message(config, item, metadata, webhook_data=None):
    tmdb = metadata.get("tmdb") or {}
    douban = metadata.get("douban") or {}
    title = display_title(item)
    media_kind = media_kind_text(item)
    icon = "📺" if media_kind == "剧集" else "🎬"
    overview = tmdb.get("overview") or douban.get("overview") or item.get("Overview") or ""
    media_item = sample_media_item(item)
    lines = [
        f"{icon} <b>新入库 {html.escape(media_kind)}</b> <b>{html.escape(title)}</b>",
        "",
        f"TMDB ID: {html.escape(tmdb_id_label(item, metadata))}",
        f"评分: {html.escape(best_rating_label(item, metadata))}",
        f"题材: {html.escape(topic_label(item, tmdb))}",
        f"地区: {html.escape(region_display(item, metadata))}",
        f"质量: {html.escape(quality_tags(media_item))}",
        f"总大小: {html.escape(size_label(total_size_value(item)))}",
        f"年份: {html.escape(str(year_label(item, tmdb, douban)))}",
        f"时间: {html.escape(format_event_time(item, webhook_data))}",
    ]
    if overview:
        trimmed = overview.strip()
        max_length = clamp_int(config.get("overviewMaxLength"), 80, 2000, 420)
        if len(trimmed) > max_length:
            trimmed = trimmed[: max_length - 3].rstrip() + "..."
        lines.append("")
        lines.append("📝 <b>剧情简介：</b>")
        lines.append(html.escape(trimmed))
    introduction = []
    if item.get("OfficialRating"):
        introduction.append(f"分级：{item.get('OfficialRating')}")
    if douban.get("title"):
        introduction.append(f"豆瓣备用：{douban.get('title')}")
    if introduction:
        lines.append("")
        lines.append(f"介绍：{html.escape('；'.join(introduction))}")
    tmdb_url = tmdb_page_url(item, metadata)
    if tmdb_url:
        lines.append("")
        lines.append(tmdb_url)
    return "\n".join(lines)


def media_seen_entry(item, source, event_at=None):
    return {
        "at": now_iso(),
        "eventAt": event_at or format_event_time(item),
        "name": format_item_title(item),
        "title": display_title(item),
        "type": item.get("Type"),
        "kind": media_kind_text(item),
        "source": source,
    }


def recent_media_rows(limit=10):
    state = get_state()
    rows = []
    for key, value in (state.get("seen") or {}).items():
        if not isinstance(value, dict):
            continue
        title = value.get("title") or value.get("name") or str(key)
        event_at = value.get("eventAt") or value.get("at") or ""
        rows.append(
            {
                "title": str(title),
                "kind": str(value.get("kind") or media_kind_text({"Type": value.get("type")})),
                "type": str(value.get("type") or ""),
                "eventAt": str(event_at),
                "source": str(value.get("source") or ""),
            }
        )
    rows.sort(key=lambda item: item.get("eventAt") or "", reverse=True)
    return rows[:limit]


def format_recent_media_message(limit=10):
    rows = recent_media_rows(limit)
    if not rows:
        return "📚 <b>最近入库</b>\n\n暂无入库记录。"
    lines = [f"📚 <b>最近入库</b>（最近 {len(rows)} 条）", ""]
    for index, row in enumerate(rows, 1):
        icon = "🎬" if row["type"] == "Movie" else "📺"
        title = html.escape(row["title"])
        kind = html.escape(row["kind"])
        event_at = html.escape((row["eventAt"] or "-")[:16])
        lines.append(f"{index}. {icon} <b>{title}</b>")
        lines.append(f"   {kind}  |  {event_at}")
    return "\n".join(lines)


def telegram_help_message():
    return "\n".join(
        [
            "🤖 <b>TG + TMDB + Emby 通知机器人</b>",
            "",
            "/recent - 查看最近入库影视",
            "/latest - 查看最近入库影视",
            "/help - 查看使用说明",
        ]
    )


def poster_for(config, item, metadata):
    if not config.get("enableCovers", True):
        return ""
    tmdb = metadata.get("tmdb") or {}
    douban = metadata.get("douban") or {}
    if tmdb.get("poster_path"):
        return tmdb_image_url(tmdb["poster_path"])
    if douban.get("poster"):
        return douban["poster"]
    if item.get("ImageTags", {}).get("Primary"):
        return ""
    return ""


def send_telegram_notification(config, item, metadata, webhook_data=None):
    require_fields(config, ["telegramBotToken", "telegramChatId"])
    message = format_message(config, item, metadata, webhook_data=webhook_data)
    poster = poster_for(config, item, metadata)
    token = config["telegramBotToken"]
    for chat_id in parse_chat_ids(config["telegramChatId"]):
        if poster:
            url = f"https://api.telegram.org/bot{token}/sendPhoto"
            payload = {
                "chat_id": chat_id,
                "photo": poster,
                "caption": message,
                "parse_mode": "HTML",
            }
        else:
            url = f"https://api.telegram.org/bot{token}/sendMessage"
            payload = {
                "chat_id": chat_id,
                "text": message,
                "parse_mode": "HTML",
                "disable_web_page_preview": "false",
            }
        result = request_form("POST", url, config, payload)
        if not result or not result.get("ok"):
            raise ApiError(f"Telegram 返回异常：chat_id={chat_id} / {telegram_error_detail(result)}")


def scan_once(send_notifications=True):
    config = get_config()
    require_fields(config, ["embyUrl", "embyApiKey"])
    state = get_state()
    seen = state.setdefault("seen", {})
    latest = get_latest_items(config)
    if not isinstance(latest, list):
        raise ApiError("Emby 最新项目返回格式异常")
    newest_first = list(latest)
    first_scan = not bool(seen)
    should_send = send_notifications and (config.get("notifyFirstRun") or not first_scan)
    sent = 0
    recorded = 0
    errors = []
    for item in reversed(newest_first):
        item_id = str(item.get("Id") or "")
        if not item_id or item_id in seen:
            continue
        metadata = build_metadata(config, item)
        if should_send:
            try:
                send_telegram_notification(config, item, metadata)
                sent += 1
                add_log(f"已推送：{format_item_title(item)}")
            except Exception as exc:
                errors.append(f"{format_item_title(item)}: {exc}")
                add_log(f"推送失败：{format_item_title(item)} - {exc}")
                continue
        seen[item_id] = media_seen_entry(item, "poller")
        recorded += 1
    state["lastScanAt"] = now_iso()
    if errors:
        state["lastError"] = "; ".join(errors[:5])
    else:
        state["lastError"] = ""
    summary = f"扫描完成：最新 {len(latest)} 个，新增记录 {recorded} 个，推送 {sent} 条"
    if first_scan and not config.get("notifyFirstRun"):
        summary += "；首次扫描已建档，未推送历史项目"
    state["lastSummary"] = summary
    save_state(state)
    add_log(summary)
    return {"summary": summary, "sent": sent, "recorded": recorded, "total": len(latest), "errors": errors}


def extract_webhook_item_id(payload):
    return str(
        find_nested_value(
            payload,
            ["ItemId", "ItemID", "item_id", "Id", "Item.Id", "itemId", "MediaItemId", "ObjectId"],
        )
        or ""
    ).strip()


def event_name_from_payload(payload):
    return str(
        find_nested_value(
            payload,
            ["Event", "event", "NotificationType", "notification_type", "event_type", "EventName", "eventName"],
        )
        or ""
    ).strip()


def is_library_new_event(config, event):
    event_lower = str(event or "").strip().lower()
    if not event_lower:
        return True
    monitored = [
        item.strip().lower()
        for item in str(config.get("monitoredEvents") or "").split(",")
        if item.strip()
    ]
    if event_lower in monitored:
        return True
    new_markers = ("library.new", "item.add", "itemadded", "item.created", "media.add", "created")
    return any(marker in event_lower for marker in new_markers)


def normalize_webhook_item(payload):
    item = find_nested_value(payload, ["Item"])
    if not isinstance(item, dict):
        item = {}
    item_id = extract_webhook_item_id(payload)
    if item_id and not item.get("Id"):
        item["Id"] = item_id
    name = find_nested_value(payload, ["ItemName", "Name", "Title", "item_name"])
    if name and not item.get("Name"):
        item["Name"] = str(name)
    item_type = find_nested_value(payload, ["ItemType", "Type", "item_type"])
    if item_type and not item.get("Type"):
        item["Type"] = str(item_type)
    date_added = find_nested_value(payload, ["ItemDateAdded", "DateCreated", "DateAdded"])
    if date_added and not item.get("DateCreated"):
        item["DateCreated"] = str(date_added)
    series = find_nested_value(payload, ["SeriesName", "series_name"])
    if series and not item.get("SeriesName"):
        item["SeriesName"] = str(series)
    return item


def is_webhook_connectivity_test(payload):
    if not isinstance(payload, dict) or not payload:
        return True
    event = event_name_from_payload(payload).lower()
    if event in {"test", "notification.test", "notifications.test", "webhook.test"}:
        return True
    if any(marker in event for marker in ("notificationtest", "notification.test", "webhook.test")):
        return True
    item_id = extract_webhook_item_id(payload)
    name = find_nested_value(payload, ["ItemName", "Name", "Title", "item_name"])
    raw_text = " ".join(str(value).lower() for value in payload.values() if isinstance(value, (str, int, float)))
    test_markers = ("test notification", "notification test", "测试通知", "测试消息", "test")
    return not item_id and not name and any(marker in raw_text for marker in test_markers)


def get_emby_item(config, item_id):
    fields = ",".join(EMBY_ITEM_FIELDS)
    return emby_get(config, f"Items/{urllib.parse.quote(str(item_id))}", params={"Fields": fields})


def extract_emby_items(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get("Items"), list):
        return value["Items"]
    return []


def get_series_episodes(config, series_id):
    fields = ",".join(EMBY_ITEM_FIELDS)
    raw_series_id = str(series_id)
    series_id = urllib.parse.quote(raw_series_id)
    user_id = config.get("embyUserId")
    item_params = {
        "Recursive": "true",
        "IncludeItemTypes": "Episode",
        "SeriesId": series_id,
        "Fields": fields,
        "EnableImages": "true",
        "SortBy": "DateCreated",
        "SortOrder": "Descending",
        "Limit": 100,
    }
    candidates = []
    if user_id:
        candidates.append((f"Users/{urllib.parse.quote(user_id)}/Items", item_params))
    candidates.extend(
        [
            ("Items", item_params),
            (f"Shows/{series_id}/Episodes", {"Fields": fields, "EnableImages": "true", "Limit": 100}),
        ]
    )
    last_error = None
    for path, params in candidates:
        try:
            episodes = extract_emby_items(emby_get(config, path, params=params))
            filtered = [
                episode
                for episode in episodes
                if not episode.get("SeriesId") or str(episode.get("SeriesId")) == raw_series_id
            ]
            episodes = filtered or episodes
            if episodes:
                return episodes
        except Exception as exc:
            last_error = exc
    if last_error:
        add_log(f"读取剧集分集失败：{last_error}")
    return []


def episode_date_raw(episode):
    return episode.get("DateCreated") or episode.get("DateAdded") or ""


def select_recent_episode_batch(episodes, webhook_data=None):
    episodes = [item for item in episodes or [] if item.get("Type") == "Episode"]
    if not episodes:
        return []
    dated = [(episode, compact_time(episode_date_raw(episode))[:10]) for episode in episodes]
    event_date = compact_time(event_time_raw({}, webhook_data))[:10]
    selected = [episode for episode, date_text in dated if event_date and date_text == event_date]
    if not selected:
        latest_date = next((date_text for _, date_text in dated if date_text), "")
        selected = [episode for episode, date_text in dated if latest_date and date_text == latest_date]
    if not selected:
        selected = episodes[:1]
    return sorted(selected[:30], key=episode_sort_key)


def enrich_series_batch(config, item, webhook_data=None):
    if item.get("Type") != "Series" or not item.get("Id"):
        return item
    episodes = select_recent_episode_batch(get_series_episodes(config, item["Id"]), webhook_data)
    if not episodes:
        return item
    item["_RecentEpisodes"] = episodes
    item["_EpisodeRange"] = format_episode_range(episodes)
    sample = episodes[0]
    for key in ("MediaSources", "MediaStreams"):
        if not item.get(key) and sample.get(key):
            item[key] = sample[key]
    return item


def handle_emby_webhook(payload, headers=None, query=None):
    config = get_config()
    secret = config.get("webhookSecret", "")
    query = query or {}
    headers = headers or {}
    received_secret = (
        query.get("token", [""])[0]
        or query.get("secret", [""])[0]
        or headers.get("X-Webhook-Token", "")
        or headers.get("X-Emby-Webhook-Secret", "")
    )
    if secret and received_secret != secret:
        raise ApiError("Webhook 密钥不正确", status=HTTPStatus.FORBIDDEN)

    if is_webhook_connectivity_test(payload):
        state = get_state()
        state["lastWebhookAt"] = now_iso()
        state["lastError"] = ""
        try:
            sent = send_telegram_text(config, TEST_MESSAGE)
            state["lastSummary"] = f"Emby Webhook 测试成功，Telegram 已发送 {sent} 个会话"
            add_log(state["lastSummary"])
            save_state(state)
            return {"ignored": False, "test": True, "sent": sent}
        except ApiError as exc:
            state["lastError"] = str(exc)
            state["lastSummary"] = "Emby Webhook 测试已收到，但 Telegram 测试发送失败"
            add_log(f"{state['lastSummary']}：{exc}")
            save_state(state)
            return {"ignored": False, "test": True, "telegramError": str(exc), "telegramBody": exc.body}

    require_fields(config, ["telegramBotToken", "telegramChatId"])

    event = event_name_from_payload(payload)
    if event and not is_library_new_event(config, event):
        add_log(f"Webhook 已忽略事件：{event}")
        return {"ignored": True, "reason": f"非入库事件：{event}"}

    item = normalize_webhook_item(payload)
    item["_WebhookReceivedAt"] = now_iso()
    item_id = str(item.get("Id") or "")
    if item_id:
        try:
            full_item = get_emby_item(config, item_id)
            if isinstance(full_item, dict):
                full_item.update({key: value for key, value in item.items() if value not in (None, "")})
                item = full_item
        except Exception as exc:
            add_log(f"Webhook 拉取 Emby 项目详情失败，使用推送内容：{exc}")
    item = enrich_series_batch(config, item, payload)
    if not item.get("Name"):
        raise ApiError("Webhook 内容里没有项目名称或 ItemId")

    include_types = set(config.get("includeTypes") or [])
    item_type = item.get("Type")
    series_as_episode = item_type == "Series" and item.get("_RecentEpisodes") and "Episode" in include_types
    if include_types and item_type and item_type not in include_types and not series_as_episode:
        add_log(f"Webhook 已忽略类型：{item_type} / {format_item_title(item)}")
        return {"ignored": True, "reason": f"未启用类型：{item_type}"}

    state = get_state()
    seen = state.setdefault("seen", {})
    dedupe_key = item_id or f"webhook:{item_type}:{item.get('Name')}:{format_event_time(item, payload)}"
    if dedupe_key in seen:
        add_log(f"Webhook 重复，已跳过：{format_item_title(item)}")
        return {"ignored": True, "reason": "重复项目"}

    metadata = build_metadata(config, item)
    send_telegram_notification(config, item, metadata, webhook_data=payload)
    seen[dedupe_key] = media_seen_entry(item, "webhook", event_at=format_event_time(item, payload))
    state["lastWebhookAt"] = now_iso()
    state["lastError"] = ""
    state["lastSummary"] = f"Webhook 推送完成：{format_item_title(item)}"
    save_state(state)
    add_log(state["lastSummary"])
    return {"ignored": False, "title": format_item_title(item)}


def poller_loop():
    add_log("轮询已启动")
    while not stop_event.is_set():
        with runtime_lock:
            runtime["lastTickAt"] = now_iso()
        try:
            scan_once(send_notifications=True)
        except Exception as exc:
            state = get_state()
            state["lastError"] = str(exc)
            save_state(state)
            add_log(f"轮询错误：{exc}")
            traceback.print_exc()
        interval = get_config().get("pollIntervalSeconds", 300)
        stop_event.wait(interval)
    add_log("轮询已停止")


def start_poller():
    global poller_thread
    with runtime_lock:
        if runtime["running"] and poller_thread and poller_thread.is_alive():
            return False
        stop_event.clear()
        poller_thread = threading.Thread(target=poller_loop, daemon=True)
        runtime["running"] = True
        poller_thread.start()
        return True


def stop_poller():
    stop_event.set()
    with runtime_lock:
        runtime["running"] = False
    if poller_thread and poller_thread.is_alive():
        poller_thread.join(timeout=3)


def is_authorized_chat(config, chat_id):
    try:
        allowed = set(parse_chat_ids(config.get("telegramChatId", "")))
    except ApiError:
        return False
    return str(chat_id) in allowed


def handle_telegram_command(config, update):
    message = update.get("message") or update.get("edited_message") or {}
    text = str(message.get("text") or "").strip()
    if not text.startswith("/"):
        return
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if chat_id is None:
        return
    if not is_authorized_chat(config, chat_id):
        add_log(f"Telegram 命令已忽略，未授权会话：{chat_id}")
        return
    command = text.split()[0].split("@")[0].lower()
    reply_to = message.get("message_id")
    if command in ("/recent", "/latest"):
        send_telegram_text_to_chat(config, chat_id, format_recent_media_message(), reply_to_message_id=reply_to)
        add_log(f"Telegram 菜单命令已响应：{command} / {chat_id}")
    elif command in ("/start", "/help"):
        send_telegram_text_to_chat(config, chat_id, telegram_help_message(), reply_to_message_id=reply_to)
        add_log(f"Telegram 帮助命令已响应：{command} / {chat_id}")


def telegram_command_loop():
    add_log("Telegram 菜单监听已启动")
    last_menu_token = ""
    last_error = ""
    while not telegram_stop_event.is_set():
        config = get_config()
        if not config.get("telegramBotToken"):
            telegram_stop_event.wait(10)
            continue
        try:
            if config.get("telegramBotToken") != last_menu_token:
                setup_telegram_commands(config)
                last_menu_token = config.get("telegramBotToken")
                add_log("Telegram 菜单命令已设置：/recent /start /help")
            state = get_state()
            offset = state.get("telegramUpdateOffset")
            payload = {"timeout": 25, "allowed_updates": ["message", "edited_message"]}
            if offset:
                payload["offset"] = offset
            result = telegram_json(config, "getUpdates", payload, timeout=35)
            if not result or not result.get("ok"):
                raise ApiError(f"Telegram 更新读取失败：{telegram_error_detail(result)}")
            updates = result.get("result") or []
            max_update_id = None
            for update in updates:
                update_id = update.get("update_id")
                if isinstance(update_id, int):
                    max_update_id = update_id if max_update_id is None else max(max_update_id, update_id)
                try:
                    handle_telegram_command(config, update)
                except Exception as exc:
                    add_log(f"Telegram 命令处理失败：{exc}")
            if max_update_id is not None:
                state = get_state()
                state["telegramUpdateOffset"] = max_update_id + 1
                save_state(state)
            last_error = ""
        except Exception as exc:
            message = str(exc)
            if message != last_error:
                add_log(f"Telegram 菜单监听异常：{message}")
                last_error = message
            telegram_stop_event.wait(10)
    add_log("Telegram 菜单监听已停止")


def start_telegram_command_listener():
    global telegram_thread
    with runtime_lock:
        if runtime.get("telegramRunning") and telegram_thread and telegram_thread.is_alive():
            return False
        telegram_stop_event.clear()
        telegram_thread = threading.Thread(target=telegram_command_loop, daemon=True)
        runtime["telegramRunning"] = True
        telegram_thread.start()
        return True


def stop_telegram_command_listener():
    telegram_stop_event.set()
    with runtime_lock:
        runtime["telegramRunning"] = False
    if telegram_thread and telegram_thread.is_alive():
        telegram_thread.join(timeout=5)


def runtime_status():
    state = get_state()
    with runtime_lock:
        running = bool(runtime["running"] and poller_thread and poller_thread.is_alive())
        runtime["running"] = running
        telegram_running = bool(runtime.get("telegramRunning") and telegram_thread and telegram_thread.is_alive())
        runtime["telegramRunning"] = telegram_running
        logs = list(runtime["logs"])[-40:]
        last_tick = runtime["lastTickAt"]
    return {
        "version": APP_VERSION,
        "running": running,
        "telegramRunning": telegram_running,
        "lastTickAt": last_tick,
        "lastScanAt": state.get("lastScanAt"),
        "lastWebhookAt": state.get("lastWebhookAt"),
        "lastError": state.get("lastError"),
        "lastSummary": state.get("lastSummary"),
        "seenCount": len(state.get("seen") or {}),
        "logs": logs,
    }


def clear_seen():
    state = get_state()
    state["seen"] = {}
    state["lastSummary"] = "已清空通知记录"
    state["lastError"] = ""
    save_state(state)
    add_log("已清空通知记录")


class Handler(SimpleHTTPRequestHandler):
    server_version = "TGEmbyBot/1.0"

    def translate_path(self, path):
        path = urllib.parse.urlparse(path).path
        path = posixpath.normpath(urllib.parse.unquote(path))
        parts = [part for part in path.split("/") if part and part not in (".", "..")]
        if not parts:
            return str(PUBLIC_DIR / "index.html")
        return str(PUBLIC_DIR.joinpath(*parts))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == "/webhook/emby":
            return self.write_json(
                {
                    "ok": True,
                    "message": "Webhook 地址在线。Emby Webhook 请使用 POST application/json 调用此地址。",
                    "path": "/webhook/emby",
                }
            )
        if self.path.startswith("/api/"):
            return self.handle_api_get()
        return super().do_GET()

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path == "/webhook/emby":
            return self.handle_emby_webhook_post()
        if self.path.startswith("/api/"):
            return self.handle_api_post()
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_emby_webhook_post(self):
        client_ip = self.client_address[0] if self.client_address else "-"
        content_type = self.headers.get("Content-Type", "-")
        try:
            add_log(f"收到 Webhook 请求：{client_ip} / {content_type}")
            payload = self.read_flexible_body()
            add_log(f"Webhook 内容字段：{', '.join(sorted(payload.keys())) if isinstance(payload, dict) else type(payload).__name__}")
            parsed_url = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(parsed_url.query)
            result = handle_emby_webhook(payload, headers=self.headers, query=query)
            return self.write_json({"ok": True, "result": result})
        except ApiError as exc:
            state = get_state()
            state["lastWebhookAt"] = now_iso()
            state["lastError"] = str(exc)
            state["lastSummary"] = "Webhook 处理失败"
            save_state(state)
            add_log(f"Webhook 处理失败：{exc}")
            status = exc.status if isinstance(exc.status, HTTPStatus) else HTTPStatus.BAD_REQUEST
            return self.write_json({"ok": False, "error": str(exc), "body": exc.body}, status=status)
        except Exception as exc:
            traceback.print_exc()
            state = get_state()
            state["lastWebhookAt"] = now_iso()
            state["lastError"] = str(exc)
            state["lastSummary"] = "Webhook 处理异常"
            save_state(state)
            add_log(f"Webhook 处理异常：{exc}")
            return self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_api_get(self):
        if self.path == "/api/config":
            return self.write_json({"config": get_config()})
        if self.path == "/api/status":
            return self.write_json({"status": runtime_status()})
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_api_post(self):
        try:
            body = self.read_json_body()
            if self.path == "/api/config":
                config = save_config(body.get("config", body))
                add_log("配置已保存")
                return self.write_json({"ok": True, "config": config})
            if self.path == "/api/start":
                started = start_poller()
                return self.write_json({"ok": True, "started": started, "status": runtime_status()})
            if self.path == "/api/stop":
                stop_poller()
                return self.write_json({"ok": True, "status": runtime_status()})
            if self.path == "/api/scan":
                result = scan_once(send_notifications=True)
                return self.write_json({"ok": True, "result": result, "status": runtime_status()})
            if self.path == "/api/test":
                target = body.get("target", "all")
                config = get_config()
                messages = []
                if target in ("emby", "all"):
                    messages.append(test_emby(config))
                if target in ("tmdb", "all"):
                    messages.append(test_tmdb(config))
                if target in ("douban", "all") and config.get("doubanFallbackEnabled"):
                    messages.append(test_douban(config))
                if target in ("telegram", "all"):
                    messages.append(test_telegram(config))
                add_log("；".join(messages))
                return self.write_json({"ok": True, "messages": messages})
            if self.path == "/api/clear-seen":
                clear_seen()
                return self.write_json({"ok": True, "status": runtime_status()})
            self.send_error(HTTPStatus.NOT_FOUND)
        except ApiError as exc:
            return self.write_json(
                {"ok": False, "error": str(exc), "body": exc.body},
                status=HTTPStatus.BAD_REQUEST,
            )
        except Exception as exc:
            traceback.print_exc()
            return self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def read_flexible_body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length).decode("utf-8", errors="replace") if length > 0 else ""
        if not raw:
            return {}
        content_type = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if content_type == "application/json":
            return json.loads(raw)
        if content_type == "application/x-www-form-urlencoded":
            form = urllib.parse.parse_qs(raw, keep_blank_values=True)
            flat = {key: values[-1] if values else "" for key, values in form.items()}
            wrapped = flat.get("data") or flat.get("json") or flat.get("payload")
            if wrapped:
                try:
                    return json.loads(wrapped)
                except json.JSONDecodeError:
                    pass
            return flat
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}

    def write_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    ensure_data_dir()
    apply_env_config()
    add_log(f"服务启动：v{APP_VERSION} / http://{HOST}:{PORT}")
    start_telegram_command_listener()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_poller()
        stop_telegram_command_listener()
        server.server_close()


if __name__ == "__main__":
    main()
