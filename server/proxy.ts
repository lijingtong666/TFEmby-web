import { ProxyAgent } from "undici";
import { config } from "./config.js";

let cachedUrl = "";
let cachedAgent: ProxyAgent | null = null;

function proxyAgent() {
  if (!config.proxyEnabled || !config.proxyUrl) return null;
  if (!cachedAgent || cachedUrl !== config.proxyUrl) {
    cachedUrl = config.proxyUrl;
    cachedAgent = new ProxyAgent(config.proxyUrl);
  }
  return cachedAgent;
}

export function externalServiceFetch(input: string | URL | Request, init: RequestInit = {}) {
  const dispatcher = proxyAgent();
  if (!dispatcher) return fetch(input, init);
  return fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: ProxyAgent });
}

export async function testProxyLatency() {
  if (!config.proxyEnabled || !config.proxyUrl) {
    return { enabled: false, ok: true, latencyMs: null as number | null, status: "未启用" };
  }
  const startedAt = performance.now();
  try {
    const response = await externalServiceFetch("https://api.telegram.org", {
      redirect: "manual",
      signal: AbortSignal.timeout(10000)
    });
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
    return {
      enabled: true,
      ok: true,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      status: `代理已连接 · HTTP ${response.status}`
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      status: (error as Error).message
    };
  }
}
