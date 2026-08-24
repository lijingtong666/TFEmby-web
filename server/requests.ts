import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSession } from "./auth.js";
import { config } from "./config.js";
import type { ChartItem, MediaRequest, RequestStatus } from "./types.js";

type RequestStore = {
  requests: MediaRequest[];
};

const storePath = path.resolve(config.dataDir, "requests.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

async function loadStore(): Promise<RequestStore> {
  try {
    return JSON.parse(await readFile(storePath, "utf8")) as RequestStore;
  } catch {
    return { requests: [] };
  }
}

async function saveStore(store: RequestStore) {
  await mkdir(path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await rename(tempPath, storePath);
}

function mutate<T>(operation: () => Promise<T>) {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.then(() => undefined, () => undefined);
  return next;
}

export async function listMediaRequests(session: AppSession) {
  const store = await loadStore();
  const visible = session.role === "admin" ? store.requests : store.requests.filter((item) => item.requestedBy.userId === session.userId);
  return visible.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createMediaRequest(session: AppSession, item: ChartItem, season?: { seasonNumber: number; seasonName: string }) {
  return mutate(async () => {
    const tmdbId = item.externalIds.tmdb;
    if (!tmdbId) {
      const error = new Error("该条目没有 TMDB ID。");
      (error as Error & { status?: number }).status = 400;
      throw error;
    }
    const store = await loadStore();
    const duplicate = store.requests.find(
      (request) =>
        request.requestedBy.userId === session.userId &&
        request.tmdbId === tmdbId &&
        request.mediaType === item.mediaType &&
        (item.mediaType === "movie" || request.seasonNumber == null || request.seasonNumber === season?.seasonNumber) &&
        request.status !== "rejected"
    );
    if (duplicate) {
      const error = new Error(season ? `你已经提交过第 ${season.seasonNumber} 季。` : "你已经提交过该条目。");
      (error as Error & { status?: number }).status = 409;
      throw error;
    }

    const timestamp = new Date().toISOString();
    const request: MediaRequest = {
      id: crypto.randomUUID(),
      tmdbId,
      mediaType: item.mediaType,
      title: item.title,
      originalTitle: item.originalTitle,
      year: item.year,
      poster: item.poster,
      overview: item.overview,
      seasonNumber: season?.seasonNumber,
      seasonName: season?.seasonName,
      requestedBy: { userId: session.userId, username: session.emby?.userName || session.username },
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    store.requests.push(request);
    await saveStore(store);
    return request;
  });
}

export function updateMediaRequest(id: string, status: RequestStatus) {
  return mutate(async () => {
    const allowed: RequestStatus[] = ["pending", "approved", "fulfilled", "rejected"];
    if (!allowed.includes(status)) {
      const error = new Error("申请状态无效。");
      (error as Error & { status?: number }).status = 400;
      throw error;
    }
    const store = await loadStore();
    const request = store.requests.find((item) => item.id === id);
    if (!request) {
      const error = new Error("申请不存在。");
      (error as Error & { status?: number }).status = 404;
      throw error;
    }
    request.status = status;
    request.updatedAt = new Date().toISOString();
    await saveStore(store);
    return request;
  });
}
