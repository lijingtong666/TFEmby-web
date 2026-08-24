import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanBaseUrl, config } from "./config.js";
import type { EmbySession } from "./types.js";

type Role = "admin" | "user";

type StoredUser = {
  id: string;
  username: string;
  role: Role;
  passwordHash?: string;
  createdAt: string;
  updatedAt: string;
  emby?: EmbySession;
};

type Store = {
  users: StoredUser[];
};

export type AppSession = {
  token: string;
  userId: string;
  username: string;
  role: Role;
  emby?: EmbySession;
};

const storePath = path.resolve(config.dataDir, "users.json");
const sessions = new Map<string, AppSession>();

async function loadStore(): Promise<Store> {
  try {
    const raw = await readFile(storePath, "utf8");
    return JSON.parse(raw) as Store;
  } catch {
    return { users: [] };
  }
}

async function saveStore(store: Store) {
  await mkdir(path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await rename(tempPath, storePath);
}

function now() {
  return new Date().toISOString();
}

function normalizeUsername(username: string) {
  return username.trim().toLowerCase();
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 210_000, 32, "sha256").toString("hex");
  return `pbkdf2$${salt}$${hash}`;
}

function verifyPassword(password: string, encoded?: string) {
  if (!encoded) return false;
  const [method, salt, hash] = encoded.split("$");
  if (method !== "pbkdf2" || !salt || !hash) return false;
  const actual = hashPassword(password, salt).split("$")[2];
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(hash, "hex"));
}

function makeSession(user: StoredUser): AppSession {
  const session: AppSession = {
    token: crypto.randomBytes(32).toString("hex"),
    userId: user.id,
    username: user.username,
    role: user.role,
    emby: user.emby
  };
  sessions.set(session.token, session);
  return session;
}

export async function authStatus() {
  const store = await loadStore();
  return {
    requiresSetup: !store.users.some((user) => user.role === "admin")
  };
}

export async function setupAdmin(username: string, password: string) {
  const cleanUsername = normalizeUsername(username);
  if (!cleanUsername || password.length < 6) {
    throw new Error("管理员用户名不能为空，密码至少 6 位。");
  }

  const store = await loadStore();
  if (store.users.some((user) => user.role === "admin")) {
    const error = new Error("管理员账户已经创建。");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }

  const user: StoredUser = {
    id: crypto.randomUUID(),
    username: cleanUsername,
    role: "admin",
    passwordHash: hashPassword(password),
    createdAt: now(),
    updatedAt: now()
  };
  store.users.push(user);
  await saveStore(store);
  return makeSession(user);
}

export async function loginLocal(username: string, password: string) {
  const cleanUsername = normalizeUsername(username);
  const store = await loadStore();
  const user = store.users.find((item) => item.username === cleanUsername && item.passwordHash);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    const error = new Error("用户名或密码错误。");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
  return makeSession(user);
}

export async function loginWithEmby(emby: EmbySession) {
  const store = await loadStore();
  const serverUrl = cleanBaseUrl(emby.serverUrl);
  const username = normalizeUsername(emby.userName);
  let user = store.users.find((item) => item.emby?.serverUrl === serverUrl && item.emby.userId === emby.userId);

  if (!user) {
    user = {
      id: crypto.randomUUID(),
      username,
      role: "user",
      createdAt: now(),
      updatedAt: now()
    };
    store.users.push(user);
  }

  user.username = user.username || username;
  user.updatedAt = now();
  user.emby = {
    ...emby,
    serverUrl
  };
  await saveStore(store);
  return makeSession(user);
}

export async function linkEmbyUser(userId: string, emby: EmbySession) {
  const store = await loadStore();
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    const error = new Error("用户不存在，请重新登录。");
    (error as Error & { status?: number }).status = 404;
    throw error;
  }

  const serverUrl = cleanBaseUrl(emby.serverUrl);
  const linked = store.users.find(
    (item) => item.id !== userId && item.emby?.serverUrl === serverUrl && item.emby.userId === emby.userId
  );
  if (linked) {
    const error = new Error("该 Emby 账户已关联其他用户。");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }

  user.emby = { ...emby, serverUrl };
  user.updatedAt = now();
  await saveStore(store);
  return makeSession(user);
}

export function sessionFromAuthHeader(authorization?: string) {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return null;
  return sessions.get(token) || null;
}
