import type { Penetration, Position, Quote } from "./types";
import { applyUnderlyingQuotes, fetchCodes, resolveToStocksCached } from "./penetration";

const timeout = (ms: number) => AbortSignal.timeout(ms);
const number = (value: string | undefined) => Number.parseFloat(value ?? "0") || 0;
const penetrationCache = new Map<string, { date: string; value: Penetration }>();
let hkdCnyCache: { expiresAt: number; rate: number } | null = null;
const shanghaiDate = (date: Date) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(date);
const dateToday = () => shanghaiDate(new Date());
const isWeekend = (date: Date) => [0, 6].includes(date.getDay());
const isNonTradingDay = (date: Date) => isWeekend(date);

type Market = "hk" | "sh" | "sz" | "us" | "unknown";

/**
 * 港股代码在不同来源中的写法不一致：配置/天天基金通常是 5 位纯数字，
 * 自动解析的结果历史上使用 rt_hk 前缀，而腾讯行情接口使用 hk 前缀。
 * 先统一识别市场，再为每个数据源生成自己的代码，避免把港股误查成深市。
 */
function marketOf(code: string): Market {
  const value = code.trim().toLowerCase();
  if (value.startsWith("rt_hk") || value.startsWith("hk") || /^\d{5}$/.test(value)) return "hk";
  if (value.startsWith("gb_")) return "us";
  if (value.startsWith("sh") || /^[65]\d{5}$/.test(value)) return "sh";
  if (value.startsWith("sz") || /^\d{6}$/.test(value)) return "sz";
  return "unknown";
}

function rawCode(code: string): string {
  const value = code.trim().toLowerCase();
  if (value.startsWith("rt_hk")) return value.slice(5).padStart(5, "0");
  if (value.startsWith("hk")) return value.slice(2).padStart(5, "0");
  return value.replace(/^(sh|sz)/, "");
}

/** 查询代码仅用于行情适配，不写回用户配置。 */
export function providerCode(code: string, provider: "tencent" | "eastmoney" | "sina"): string {
  const market = marketOf(code);
  const raw = rawCode(code);
  if (market === "hk") return provider === "eastmoney" ? `116.${raw}` : `hk${raw}`;
  if (market === "us") return code.trim().toLowerCase();
  if (market === "sh") return provider === "eastmoney" ? `1.${raw}` : `sh${raw}`;
  if (market === "sz") return provider === "eastmoney" ? `0.${raw}` : `sz${raw}`;
  return code.trim();
}

async function dailyPenetration(position: Pick<Position, "code" | "holdings">): Promise<Penetration> {
  if (position.code === "000759" || position.code === "HKD") return { mode: "auto", source: "现金资产", totalWeight: 100, holdings: [{ code: "CASH", name: "现金", weight: 100, assetClass: "cash" }] };
  // 缓存 key 包含 holdings 配置：改了构成不能命中旧穿透
  const key = `${position.code}:${JSON.stringify(position.holdings ?? null)}`;
  const cached = penetrationCache.get(key);
  if (cached?.date === dateToday()) return cached.value;
  const value = await resolveToStocksCached(position.code, position.holdings);
  penetrationCache.set(key, { date: dateToday(), value });
  return value;
}

function cashFundQuote(code: string): Quote {
  return { code, name: "平安财富宝货币A", price: 1, previousPrice: 1, dailyChange: 0, source: "cash-fund", updatedAt: new Date().toISOString() };
}

async function cashQuote(code: string, name?: string): Promise<Quote> {
  if (code === "CNY") return { code, name: name ?? code, price: 1, previousPrice: 1, dailyChange: 0, source: "CNY", updatedAt: new Date().toISOString() };
  const now = Date.now();
  if (!hkdCnyCache || hkdCnyCache.expiresAt <= now) {
    const response = await fetch("https://open.er-api.com/v6/latest/HKD", { signal: timeout(5000) });
    const payload = await response.json() as { rates?: { CNY?: number } };
    const rate = payload.rates?.CNY;
    if (!rate) throw new Error("港币汇率获取失败");
    hkdCnyCache = { rate, expiresAt: now + 5 * 60 * 1000 };
  }
  return { code, name: name ?? code, price: hkdCnyCache.rate, previousPrice: hkdCnyCache.rate, dailyChange: 0, source: "HKD/CNY", updatedAt: new Date().toISOString() };
}

function previousValue(position: Position, previousPrice?: number): number {
  return (position.effectiveShares ?? position.shares) * (previousPrice ?? 0);
}

function markToMarket(position: Position, quote: Pick<Quote, "price" | "previousPrice" | "dailyChange"> & { name?: string }, dailyChange = quote.dailyChange): Position {
  const base = previousValue(position, quote.previousPrice);
  const current = (position.effectiveShares ?? position.shares) * quote.price;
  const todayPnl = quote.previousPrice != null ? current - base : current * dailyChange / 100;
  return {
    ...position,
    // 用户配置的别名优先，没写才用网络名
    name: position.name ?? quote.name,
    currentPrice: quote.price,
    previousPrice: quote.previousPrice,
    dailyChange,
    todayPnl,
    estimatedAmount: current,
    amount: current,
  };
}

/**
 * 周末没有基金/股票/债券的新交易日收益。保留估值和穿透结构，
 * 但把收益字段统一归零，避免图表继续显示上一个交易日的涨跌。
 */
function clearDailyMovement(penetration: Penetration): Penetration {
  const clear = (node: Penetration["holdings"][number]): Penetration["holdings"][number] => ({
    ...node,
    dailyChange: 0,
    contribution: 0,
    ...(node.children?.length ? { children: node.children.map(clear) } : {}),
  });
  return { ...penetration, holdings: penetration.holdings.map(clear), estimatedChange: 0 };
}

async function fundNav(code: string): Promise<Quote | null> {
  const response = await fetch(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, { signal: timeout(8000) });
  if (!response.ok) return null;
  const text = await response.text();
  const name = text.match(/fS_name\s*=\s*"([^"]+)"/)?.[1] ?? `基金 ${code}`;
  const trend = text.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (!trend) return null;
  const rows = JSON.parse(trend[1]) as Array<{ x: number; y: number; equityReturn?: number }>;
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  if (!latest) return null;
  return {
    code,
    name,
    price: latest.y,
    previousPrice: previous?.y,
    dailyChange: latest.equityReturn ?? (previous ? ((latest.y - previous.y) / previous.y) * 100 : 0),
    source: "Eastmoney",
    updatedAt: new Date().toISOString(),
    asOfDate: shanghaiDate(new Date(latest.x)),
    navHistory: rows.map((row) => ({ date: shanghaiDate(new Date(row.x)), price: row.y })),
  };
}

/**
 * 定投份额是确认后才增加的。配置里的 shares 保持为确认基准日的原始值，
 * 运行时根据之后每个交易日的确认净值补出有效份额，不把派生结果写回配置。
 */
export function calculateEffectiveShares(position: Position, nav: Quote | null, throughDate = dateToday()): number | undefined {
  const recurring = position.recurring;
  if (!recurring || recurring.frequency !== "daily" || !recurring.sharesAsOf || !nav?.navHistory?.length) return undefined;
  const feeMultiplier = Math.max(0, 1 - (recurring.feePercent ?? 0) / 100);
  const rows = nav.navHistory
    .filter((row) => row.date > recurring.sharesAsOf! && row.date <= throughDate && row.price > 0);
  const added = rows
    .reduce((sum, row) => sum + recurring.amount * feeMultiplier / row.price, 0);
  return position.shares + added;
}

export function calculateRecurringPeriods(position: Position, nav: Quote | null, throughDate = dateToday()): number {
  const recurring = position.recurring;
  if (!recurring || recurring.frequency !== "daily" || !recurring.sharesAsOf || !nav?.navHistory?.length) return 0;
  return nav.navHistory.filter((row) => row.date > recurring.sharesAsOf! && row.date <= throughDate && row.price > 0).length;
}

async function stockQuote(code: string): Promise<Quote | null> {
  const market = marketOf(code);
  try {
    const requestCode = providerCode(code, "tencent");
    const response = await fetch(`https://qt.gtimg.cn/q=${requestCode}`, { signal: timeout(3000) });
    const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
    const payload = text.match(/="([\s\S]*)";/)?.[1]?.split("~");
    if (payload && payload.length > 5) {
      const price = number(payload[3]);
      const previous = number(payload[4]);
      return { code, name: payload[1] || code, price, previousPrice: previous, dailyChange: previous ? ((price - previous) / previous) * 100 : 0, source: "Tencent", updatedAt: new Date().toISOString() };
    }
  } catch { /* use other sources below */ }
  // Eastmoney is the primary source because it is reachable in more local/network environments.
  if (!code.startsWith("gb_")) {
    const raw = rawCode(code);
    const marketId = market === "hk" ? 116 : market === "sh" ? 1 : 0;
    try {
      const response = await fetch(`https://push2.eastmoney.com/api/qt/stock/get?secid=${marketId}.${raw}&fields=f43,f58,f60,f170`, { signal: timeout(5000) });
      const payload = await response.json() as { data?: { f43?: number; f58?: string; f60?: number; f170?: number } };
      const data = payload.data;
      if (data?.f43 && data.f60) return { code, name: data.f58 || code, price: data.f43 / 1000, previousPrice: data.f60 / 1000, dailyChange: data.f170 ? data.f170 / 100 : ((data.f43 - data.f60) / data.f60) * 100, source: "Eastmoney", updatedAt: new Date().toISOString() };
    } catch { /* use Sina fallback below */ }
  }
  try {
    const requestCode = providerCode(code, "sina");
    const response = await fetch(`https://hq.sinajs.cn/list=${requestCode}`, { headers: { Referer: "https://finance.sina.com.cn/" }, signal: timeout(3000) });
    if (!response.ok) return null;
    const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
    const payload = text.match(/="([\s\S]*)";/)?.[1]?.split(",");
    if (!payload || payload.length < 4) return null;
    const price = market === "hk" ? number(payload[6]) : market === "us" ? number(payload[1]) : number(payload[3]);
    const previous = market === "hk" ? number(payload[3]) : market === "us" ? number(payload[1]) - number(payload[2]) : number(payload[2]);
    return { code, name: payload[0] || code, price, previousPrice: previous, dailyChange: previous ? ((price - previous) / previous) * 100 : 0, source: "Sina", updatedAt: new Date().toISOString() };
  } catch { return null; }
}

async function cryptoQuote(symbol: string): Promise<Quote | null> {
  const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}USDT`, { signal: timeout(5000) });
  if (!response.ok) return null;
  const ticker = await response.json() as { lastPrice?: string; priceChangePercent?: string };
  const fxResponse = await fetch("https://open.er-api.com/v6/latest/USD", { signal: timeout(5000) });
  const fx = await fxResponse.json() as { rates?: { CNY?: number } };
  const usdCny = fx.rates?.CNY;
  const priceUsdt = Number(ticker.lastPrice);
  if (!usdCny || !priceUsdt) return null;
  const name = symbol === "BTC" ? "比特币" : symbol === "WBETH" ? "以太坊" : symbol;
  const price = priceUsdt * usdCny;
  const dailyChange = Number(ticker.priceChangePercent) || 0;
  return { code: symbol, name, price, previousPrice: price / (1 + dailyChange / 100), dailyChange, source: "Binance", updatedAt: new Date().toISOString() };
}

async function refreshFund(position: Position): Promise<Position> {
  const nonTradingDay = isNonTradingDay(new Date());
  const nav = position.code === "000759" ? cashFundQuote(position.code) : position.type === "fund" ? await fundNav(position.code) : await stockQuote(position.code);
  // etf 的行情就是它自己的报价（nav 角色）
  const ownQuote = position.type === "etf" ? nav : null;
  const penetration = await dailyPenetration(position);
  const quotes = Object.fromEntries((await Promise.all(fetchCodes(penetration).map(async (code) => [code, await stockQuote(code)] as const))).filter((entry): entry is readonly [string, Quote] => Boolean(entry[1])).map(([code, quote]) => [code, { price: quote.price, dailyChange: quote.dailyChange, name: quote.name }]));
  const resolved = applyUnderlyingQuotes(penetration, quotes);
  const effectivePenetration = nonTradingDay ? clearDailyMovement(resolved) : resolved;
  // 最新确认净值已经包含最近一个交易日的涨跌。只有在交易日且净值日期
  // 落后于今天时，才用底层资产的实时涨跌做今日估算，避免重复叠加一次跌幅。
  const estimateWithUnderlying = Boolean(
    nav?.asOfDate &&
    nav.asOfDate < dateToday() &&
    !nonTradingDay &&
    resolved.estimatedChange != null,
  );
  const estimatedPrice = estimateWithUnderlying && nav?.price != null && resolved.estimatedChange != null
    ? nav.price * (1 + resolved.estimatedChange / 100)
    : nav?.price;
  const effectivePreviousPrice = nonTradingDay
    ? nav?.price ?? ownQuote?.price ?? position.currentPrice
    : estimateWithUnderlying ? nav?.price : nav?.previousPrice;
  const effectiveDailyChange = nonTradingDay ? 0 : estimateWithUnderlying ? resolved.estimatedChange : nav?.dailyChange;
  const effectiveShares = calculateEffectiveShares(position, nav);
  const recurringPeriods = calculateRecurringPeriods(position, nav);
  const updated = {
    ...position,
    name: position.name ?? nav?.name ?? ownQuote?.name,
    currentPrice: estimatedPrice ?? ownQuote?.price ?? position.currentPrice,
    previousPrice: effectivePreviousPrice ?? ownQuote?.previousPrice ?? position.previousPrice,
    dailyChange: effectiveDailyChange ?? ownQuote?.dailyChange ?? position.dailyChange,
    ...(effectiveShares != null ? { effectiveShares } : {}),
    ...(recurringPeriods ? { recurringPeriods } : {}),
    penetration: effectivePenetration,
    updatedAt: new Date().toISOString(),
  };
  return markToMarket(updated, {
    price: updated.currentPrice ?? 0,
    previousPrice: updated.previousPrice,
    dailyChange: updated.dailyChange ?? 0,
  }, updated.dailyChange ?? 0);
}

/** 单个持仓的统一刷新：现金/加密/基金/ETF/股票共用 */
async function refreshPosition(position: Position): Promise<Position> {
  if (position.type === "cash") return markToMarket(position, await cashQuote(position.code, position.name));
  if (position.type === "crypto") {
    const quote = await cryptoQuote(position.code);
    if (!quote) return position;
    return markToMarket(position, quote);
  }
  if (position.type === "fund" || position.type === "etf") return await refreshFund(position);
  const quote = await stockQuote(position.type === "stock" && /^0\d{4}$/.test(position.code) ? `rt_hk${position.code}` : position.code);
  if (!quote) return position;
  if (isNonTradingDay(new Date())) return markToMarket(position, { ...quote, previousPrice: quote.price, dailyChange: 0 }, 0);
  return markToMarket(position, quote);
}

export async function refreshQuotes(positions: Position[]): Promise<Position[]> {
  const refreshed = await Promise.all(positions.map(async (position) => {
    try { return await refreshPosition(position); } catch { return position; }
  }));
  const fundingDebits = new Map<string, number>();
  for (const position of refreshed) {
    const recurring = position.recurring;
    if (!recurring?.fundingCode || !position.recurringPeriods) continue;
    fundingDebits.set(recurring.fundingCode, (fundingDebits.get(recurring.fundingCode) ?? 0) + recurring.amount * position.recurringPeriods);
  }
  return refreshed.map((position) => {
    const debit = fundingDebits.get(position.code);
    if (debit == null || position.currentPrice == null) return position;
    const effectiveShares = Math.max(0, position.shares - debit);
    const amount = effectiveShares * position.currentPrice;
    return { ...position, effectiveShares, estimatedAmount: amount, amount };
  });
}
