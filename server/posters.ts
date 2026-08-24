import { findDoubanPoster } from "./douban.js";
import { findTmdbPoster } from "./tmdb.js";
import type { ChartItem } from "./types.js";

async function enrichOne(item: ChartItem): Promise<ChartItem> {
  if (item.poster) return item;

  const tmdbPoster = item.source === "tmdb" ? undefined : await findTmdbPoster(item);
  const poster = tmdbPoster || (await findDoubanPoster(item));
  return poster ? { ...item, poster } : item;
}

export async function enrichChartPosters(items: ChartItem[]) {
  const result: ChartItem[] = [];
  const concurrency = 6;
  for (let index = 0; index < items.length; index += concurrency) {
    result.push(...(await Promise.all(items.slice(index, index + concurrency).map(enrichOne))));
  }
  return result;
}
