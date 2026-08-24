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
