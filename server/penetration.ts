import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Penetration, PenetrationHolding, UnderlyingConfig } from "./types";

const clean = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
function holdingFromRow(row: string): PenetrationHolding | null {
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => clean(match[1]));
  if (cells.length < 7 || !cells[6].endsWith("%")) return null;
  const link = row.match(/unify\/r\/(\d+)\.([a-zA-Z0-9]+)/);
  const code = link?.[2] ?? cells[1];
  const weight = Number.parseFloat(cells[6].replace("%", ""));
  if (!code || !Number.isFinite(weight)) return null;
  const market = Number(link?.[1] ?? 0);
  const fetchCode = market === 1 ? `sh${code}` : market === 116 ? `rt_hk${code.padStart(5, "0")}` : market >= 100 ? `gb_${code.toLowerCase()}` : code.startsWith("6") ? `sh${code}` : `sz${code}`;
  const name = cells[2] || code;
  return { code, name, weight, sector: name.includes("银行") ? "银行" : undefined, assetClass: "stock", _fetchCode: fetchCode } as PenetrationHolding & { _fetchCode: string };
}

// A-share ETF codes starting with 5 trade on SH, 1 on SZ. HK-listed ETFs would
// need explicit handling but current targets are all A-share.
const marketPrefix = (code: string) => code.startsWith("5") ? "sh" : "sz";

// Standard feeder-fund structure: ~95% in the target ETF, ~5% cash.
const FEEDER_INVESTED_WEIGHT = 95;
const FEEDER_CASH_WEIGHT = 5;

export async function fetchPenetration(code: string, underlying?: UnderlyingConfig): Promise<Penetration> {
  if (underlying?.target) {
    const holdings: PenetrationHolding[] = [{
      code: underlying.target,
      name: underlying.target,
      weight: FEEDER_INVESTED_WEIGHT,
      ...(underlying.sector ? { sector: underlying.sector } : {}),
      ...(underlying.assetClass ? { assetClass: underlying.assetClass } : {}),
      _fetchCode: `${marketPrefix(underlying.target)}${underlying.target}`,
    }];
    if (FEEDER_CASH_WEIGHT > 0) holdings.push({ code: "CASH", name: "现金及短期资产", weight: FEEDER_CASH_WEIGHT, sector: "现金", assetClass: "cash" });
    return {
      mode: "feeder-etf",
      source: `fund allocation (${FEEDER_INVESTED_WEIGHT}% target ETF + ${FEEDER_CASH_WEIGHT}% cash)`,
      totalWeight: FEEDER_INVESTED_WEIGHT + FEEDER_CASH_WEIGHT,
      underlyingCode: underlying.target,
      holdings,
    };
  }
  try {
    const url = new URL("https://fundf10.eastmoney.com/FundArchivesDatas.aspx");
    url.search = new URLSearchParams({ type: "jjcc", code, topline: "10", year: "", month: "" }).toString();
    const response = await fetch(url, { headers: { Referer: `https://fundf10.eastmoney.com/ccmx_${code}.html` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const reportDate = text.match(/截止至：<font class=['"]px12['"]>(.*?)<\/font>/)?.[1];
    const encoded = text.match(/content:\"([\s\S]*?)\",\s*\w+\s*[:=]/)?.[1] ?? text.split('content:"')[1]?.split('",')[0];
    const holdings = encoded ? [...encoded.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((match) => holdingFromRow(match[1])).filter(Boolean) as Array<PenetrationHolding & { _fetchCode: string }> : [];
    if (!holdings.length) return { mode: "unavailable", source: "Eastmoney", reportDate, totalWeight: 0, holdings: [] };
    return {
      mode: "top10", source: "Eastmoney quarterly holdings", reportDate,
      totalWeight: holdings.reduce((sum, item) => sum + item.weight, 0),
      holdings: holdings.map(({ _fetchCode, ...item }) => ({ ...item, _fetchCode } as PenetrationHolding)),
    };
  } catch {
    return { mode: "unavailable", source: "Eastmoney", totalWeight: 0, holdings: [] };
  }
}

function looksLikeEtf(holding: PenetrationHolding): boolean {
  return holding.name.toUpperCase().includes("ETF") || /^(15|16|50|51|56|58)/.test(holding.code);
}

async function expandNestedEtfs(penetration: Penetration, depth: number): Promise<Penetration> {
  if (penetration.mode !== "top10" || depth >= 3) return penetration;
  const expanded: PenetrationHolding[] = [];
  let changed = false;
  for (const holding of penetration.holdings) {
    if (!looksLikeEtf(holding)) {
      expanded.push(holding);
      continue;
    }
    const nested = await fetchPenetration(holding.code);
    if (nested.mode !== "top10" || !nested.holdings.length || !nested.totalWeight) {
      expanded.push(holding);
      continue;
    }
    changed = true;
    const nestedExpanded = await expandNestedEtfs(nested, depth + 1);
    for (const child of nestedExpanded.holdings) {
      expanded.push({ ...child, weight: holding.weight * child.weight / nestedExpanded.totalWeight });
    }
  }
  return changed ? { ...penetration, holdings: expanded, totalWeight: expanded.reduce((sum, item) => sum + item.weight, 0), source: `${penetration.source} -> ETF constituents` } : penetration;
}

export async function resolveToStocks(code: string, underlying?: UnderlyingConfig): Promise<Penetration> {
  const current = await fetchPenetration(code, underlying);
  let base = current;
  if (current.mode === "feeder-etf" && current.underlyingCode) {
    const nested = await fetchPenetration(current.underlyingCode);
    const fallback = underlying?.fallbackHoldings?.length ? underlying.fallbackHoldings : undefined;
    const underlyingResolved = nested.mode === "top10" ? nested : fallback ? { mode: "top10" as const, source: `official factsheet constituent fallback`, totalWeight: fallback.reduce((sum, item) => sum + item.weight, 0), holdings: fallback.map(({ code, weight }) => {
      const fetchCode = /^\d{5}$/.test(code) ? `rt_hk${code}` : code;
      return { code, name: code, weight, assetClass: "stock" as const, _fetchCode: fetchCode };
    }) } : nested;
    if (underlyingResolved.mode === "top10") {
      const investableWeight = current.holdings.filter((item) => item.assetClass !== "cash").reduce((sum, item) => sum + item.weight, 0);
      const expanded = underlyingResolved.holdings.map((item) => ({ ...item, weight: investableWeight * item.weight / underlyingResolved.totalWeight }));
      const cash = current.holdings.filter((item) => item.assetClass === "cash");
      base = { ...underlyingResolved, source: `${current.source} -> ${underlyingResolved.source}`, totalWeight: current.totalWeight, holdings: [...expanded, ...cash] };
    }
  }
  return expandNestedEtfs(base, 0);
}

// Persisted cache of resolved penetration data, keyed by fund code,
// stored under data/cache/penetration/<code>.json. Purely renewable data:
// safe to delete anytime - a miss, stale or corrupt entry just triggers a
// fresh fetch, so it never affects correctness.
const penetrationCacheDir = join(import.meta.dir, "..", "data", "cache", "penetration");
const penetrationCacheFile = (code: string) => join(penetrationCacheDir, `${code}.json`);
const dateToday = () => new Date().toISOString().slice(0, 10);

export async function resolveToStocksCached(code: string, underlying?: UnderlyingConfig): Promise<Penetration> {
  const target = underlying?.target ?? null;
  try {
    const cached = await Bun.file(penetrationCacheFile(code)).json() as { date?: string; underlyingTarget?: string | null; value?: Penetration } | null;
    if (cached?.date === dateToday() && cached.underlyingTarget === target && cached.value && Array.isArray(cached.value.holdings)) return cached.value;
  } catch { /* miss or corrupt -> refetch */ }
  const value = await resolveToStocks(code, underlying);
  try {
    await mkdir(penetrationCacheDir, { recursive: true });
    await Bun.write(penetrationCacheFile(code), JSON.stringify({ date: dateToday(), underlyingTarget: target, value }));
  } catch (error) {
    console.warn(`[penetration] 缓存写入失败(不影响功能) ${penetrationCacheFile(code)}:`, error);
  }
  return value;
}

export function fetchCodes(penetration: Penetration): string[] {
  return penetration.holdings.filter((item) => item.assetClass !== "cash").map((item) => (item as PenetrationHolding & { _fetchCode?: string })._fetchCode ?? item.code);
}

export function applyUnderlyingQuotes(penetration: Penetration, quotes: Record<string, { price: number; dailyChange: number }>): Penetration {
  let weighted = 0;
  let usedWeight = 0;
  const holdings = penetration.holdings.map((holding) => {
    const key = (holding as PenetrationHolding & { _fetchCode?: string })._fetchCode ?? holding.code;
    const quote = quotes[key];
    if (!quote) return holding;
    weighted += holding.weight * quote.dailyChange;
    usedWeight += holding.weight;
    return { ...holding, price: quote.price, dailyChange: quote.dailyChange, contribution: holding.weight * quote.dailyChange };
  });
  const denominator = penetration.mode === "feeder-etf" ? penetration.totalWeight : usedWeight;
  return { ...penetration, holdings, totalWeight: penetration.mode === "feeder-etf" ? penetration.totalWeight : (usedWeight || penetration.totalWeight), estimatedChange: denominator ? weighted / denominator : undefined };
}
