import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Holding, Penetration } from "./types";

/** 递归展开的最大深度，防止循环嵌套 */
const MAX_DEPTH = 5;

const clean = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();

function holdingFromRow(row: string): Holding | null {
  const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => clean(match[1]));
  if (cells.length < 7 || !cells[6].endsWith("%")) return null;
  const link = row.match(/unify\/r\/(\d+)\.([a-zA-Z0-9]+)/);
  const code = link?.[2] ?? cells[1];
  const weight = Number.parseFloat(cells[6].replace("%", ""));
  if (!code || !Number.isFinite(weight)) return null;
  const market = Number(link?.[1] ?? 0);
  const fetchCode = market === 1 ? `sh${code}` : market === 116 ? `rt_hk${code.padStart(5, "0")}` : market >= 100 ? `gb_${code.toLowerCase()}` : code.startsWith("6") ? `sh${code}` : `sz${code}`;
  const name = cells[2] || code;
  return { code, name, weight, sector: name.includes("银行") ? "银行" : undefined, assetClass: "stock", _fetchCode: fetchCode };
}

/** A 股 ETF/基金代码启发式（沪 5 开头、深 15/16 等），名称含 ETF 也算 */
function looksLikeFundOrEtf(node: Holding): boolean {
  const code = node.code ?? "";
  const name = node.name ?? "";
  return name.toUpperCase().includes("ETF") || /^(15|16|50|51|56|58)/.test(code);
}

/** 拉取一个资产的一层构成（不递归）。股票/实物资产返回 unavailable。 */
export async function fetchPenetration(code: string): Promise<Penetration> {
  try {
    const url = new URL("https://fundf10.eastmoney.com/FundArchivesDatas.aspx");
    url.search = new URLSearchParams({ type: "jjcc", code, topline: "10", year: "", month: "" }).toString();
    const response = await fetch(url, { headers: { Referer: `https://fundf10.eastmoney.com/ccmx_${code}.html` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const reportDate = text.match(/截止至：<font class=['"]px12['"]>(.*?)<\/font>/)?.[1];
    const encoded = text.match(/content:\"([\s\S]*?)\",\s*\w+\s*[:=]/)?.[1] ?? text.split('content:"')[1]?.split('",')[0];
    const holdings = encoded ? [...encoded.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((match) => holdingFromRow(match[1])).filter(Boolean) as Holding[] : [];
    if (!holdings.length) return { mode: "unavailable", source: "Eastmoney", reportDate, totalWeight: 0, holdings: [] };
    return {
      mode: "auto", source: "Eastmoney quarterly holdings", reportDate,
      totalWeight: holdings.reduce((sum, item) => sum + item.weight, 0),
      holdings,
    };
  } catch {
    return { mode: "unavailable", source: "Eastmoney", totalWeight: 0, holdings: [] };
  }
}

/** 递归展开：有代码且像基金/ETF 的节点，尝试拉它的构成挂到 children，直到叶子或最大深度 */
async function expandNode(node: Holding, depth: number): Promise<Holding> {
  if (!node.code || node.children?.length || depth >= MAX_DEPTH) return node;
  if (node.assetClass === "stock" || node.assetClass === "crypto") return node;
  if (!looksLikeFundOrEtf(node)) return node;
  const fetched = await fetchPenetration(node.code);
  if (fetched.mode !== "auto" || !fetched.holdings.length) return node;
  const children = await Promise.all(fetched.holdings.map((child) => expandNode(child, depth + 1)));
  return { ...node, children };
}

/** 配置指定构成：从配置树出发，自动展开其中的基金/ETF 节点 */
async function resolveConfigured(holdings: Holding[]): Promise<Penetration> {
  const expanded = await Promise.all(holdings.map((node) => expandNode(node, 0)));
  return {
    mode: "override",
    source: "config holdings",
    totalWeight: expanded.reduce((sum, item) => sum + item.weight, 0) || 100,
    holdings: expanded,
  };
}

/** 自动穿透：拉基金季报，再递归展开其中的 ETF */
async function resolveAuto(code: string): Promise<Penetration> {
  const top = await fetchPenetration(code);
  if (top.mode !== "auto" || !top.holdings.length) return top;
  const holdings = await Promise.all(top.holdings.map((node) => expandNode(node, 0)));
  return { ...top, holdings };
}

export async function resolveToStocks(code: string, holdings?: Holding[]): Promise<Penetration> {
  if (holdings?.length) return resolveConfigured(holdings);
  return resolveAuto(code);
}

// Persisted cache of resolved penetration trees, keyed by fund code,
// stored under data/cache/penetration/<code>.json. Purely renewable data:
// safe to delete anytime - a miss, stale or corrupt entry just triggers a
// fresh fetch, so it never affects correctness.
const penetrationCacheDir = join(import.meta.dir, "..", "data", "cache", "penetration");
const penetrationCacheFile = (code: string) => join(penetrationCacheDir, `${code}.json`);
const dateToday = () => new Date().toISOString().slice(0, 10);

export async function resolveToStocksCached(code: string, holdings?: Holding[]): Promise<Penetration> {
  const holdingsKey = JSON.stringify(holdings ?? null);
  try {
    const cached = await Bun.file(penetrationCacheFile(code)).json() as { date?: string; holdingsKey?: string; value?: Penetration } | null;
    if (cached?.date === dateToday() && cached.holdingsKey === holdingsKey && cached.value && Array.isArray(cached.value.holdings)) return cached.value;
  } catch { /* miss or corrupt -> refetch */ }
  const value = await resolveToStocks(code, holdings);
  try {
    await mkdir(penetrationCacheDir, { recursive: true });
    await Bun.write(penetrationCacheFile(code), JSON.stringify({ date: dateToday(), holdingsKey, value }));
  } catch (error) {
    console.warn(`[penetration] 缓存写入失败(不影响功能) ${penetrationCacheFile(code)}:`, error);
  }
  return value;
}

/** 收集树中所有需要行情的叶子代码 */
export function fetchCodes(penetration: Penetration): string[] {
  const codes: string[] = [];
  const walk = (node: Holding) => {
    if (node.children?.length) node.children.forEach(walk);
    else if (node.code && node.assetClass !== "cash") codes.push(node._fetchCode ?? node.code);
  };
  penetration.holdings.forEach(walk);
  return codes;
}

/**
 * 递归填行情与涨跌：叶子取 quote，父节点 = 子节点按权重加权。
 * 返回的树每层都带上 dailyChange；根层的估算涨跌放 estimatedChange。
 */
export function applyUnderlyingQuotes(penetration: Penetration, quotes: Record<string, { price: number; dailyChange: number; name?: string }>): Penetration {
  const apply = (node: Holding): Holding => {
    if (node.children?.length) {
      let weighted = 0;
      let used = 0;
      const children = node.children.map((child) => {
        const resolved = apply(child);
        if (resolved.dailyChange == null) return resolved;
        weighted += resolved.weight * resolved.dailyChange;
        used += resolved.weight;
        return resolved;
      });
      const change = used ? weighted / used : undefined;
      return { ...node, children, dailyChange: change, contribution: change != null ? node.weight * change : undefined };
    }
    const key = node._fetchCode ?? node.code ?? "";
    const quote = quotes[key];
    if (!quote) return node;
    return {
      ...node,
      // 配置里只带代码的节点，用行情名补上显示名
      name: node.name && node.name !== node.code ? node.name : quote.name ?? node.name ?? node.code,
      price: quote.price,
      dailyChange: quote.dailyChange,
      contribution: node.weight * quote.dailyChange,
    };
  };
  const holdings = penetration.holdings.map(apply);
  let weighted = 0;
  let used = 0;
  for (const node of holdings) {
    if (node.dailyChange == null) continue;
    weighted += node.weight * node.dailyChange;
    used += node.weight;
  }
  return { ...penetration, holdings, estimatedChange: used ? weighted / used : undefined };
}
