import type { Penetration, Position, Quote } from "./types";
import { applyUnderlyingQuotes, fetchCodes, resolveToStocksCached } from "./penetration";

const timeout = (ms: number) => AbortSignal.timeout(ms);
const number = (value: string | undefined) => Number.parseFloat(value ?? "0") || 0;
const penetrationCache = new Map<string, { date: string; value: Penetration }>();
let hkdCnyCache: { expiresAt: number; rate: number } | null = null;
const dateToday = () => new Date().toISOString().slice(0, 10);

async function dailyPenetration(position: Pick<Position, "code" | "underlying">): Promise<Penetration> {
  if (position.code === "000759" || position.code === "HKD") return { mode: "top10", source: "现金资产", totalWeight: 100, holdings: [{ code: "CASH", name: "现金", weight: 100, sector: "现金", assetClass: "cash" }] };
  const cached = penetrationCache.get(position.code);
  if (cached?.date === dateToday()) return cached.value;
  const value = await resolveToStocksCached(position.code, position.underlying);
  penetrationCache.set(position.code, { date: dateToday(), value });
  return value;
}

function cashFundQuote(code: string): Quote {
  return { code, name: "平安财富宝货币A", price: 1, previousPrice: 1, dailyChange: 0, source: "cash-fund", updatedAt: new Date().toISOString() };
}

async function cashQuote(code: string, name: string): Promise<Quote> {
  if (code === "CNY") return { code, name, price: 1, previousPrice: 1, dailyChange: 0, source: "CNY", updatedAt: new Date().toISOString() };
  const now = Date.now();
  if (!hkdCnyCache || hkdCnyCache.expiresAt <= now) {
    const response = await fetch("https://open.er-api.com/v6/latest/HKD", { signal: timeout(5000) });
    const payload = await response.json() as { rates?: { CNY?: number } };
    const rate = payload.rates?.CNY;
    if (!rate) throw new Error("港币汇率获取失败");
    hkdCnyCache = { rate, expiresAt: now + 5 * 60 * 1000 };
  }
  return { code, name, price: hkdCnyCache.rate, previousPrice: hkdCnyCache.rate, dailyChange: 0, source: "HKD/CNY", updatedAt: new Date().toISOString() };
}

function previousValue(position: Position, previousPrice?: number): number {
  return position.shares * (previousPrice ?? 0);
}

function markToMarket(position: Position, quote: Pick<Quote, "price" | "previousPrice" | "dailyChange">, dailyChange = quote.dailyChange): Position {
  const base = previousValue(position, quote.previousPrice);
  const todayPnl = base * dailyChange / 100;
  return {
    ...position,
    currentPrice: quote.price,
    previousPrice: quote.previousPrice,
    dailyChange,
    todayPnl,
    estimatedAmount: base + todayPnl,
    amount: base + todayPnl,
  };
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
  return { code, name, price: latest.y, previousPrice: previous?.y, dailyChange: latest.equityReturn ?? (previous ? ((latest.y - previous.y) / previous.y) * 100 : 0), source: "Eastmoney", updatedAt: new Date().toISOString(), asOfDate: new Date(latest.x).toISOString().slice(0, 10) };
}

async function stockQuote(code: string): Promise<Quote | null> {
  try {
    const requestCode = code.startsWith("sh") || code.startsWith("sz") ? code : code.startsWith("6") || code.startsWith("5") ? `sh${code}` : `sz${code}`;
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
    const raw = code.startsWith("rt_hk") ? code.slice(5) : code.replace(/^(sh|sz)/, "");
    const market = code.startsWith("rt_hk") ? 116 : code.startsWith("sh") || raw.startsWith("6") || raw.startsWith("5") ? 1 : 0;
    try {
      const response = await fetch(`https://push2.eastmoney.com/api/qt/stock/get?secid=${market}.${raw}&fields=f43,f58,f60,f170`, { signal: timeout(5000) });
      const payload = await response.json() as { data?: { f43?: number; f58?: string; f60?: number; f170?: number } };
      const data = payload.data;
      if (data?.f43 && data.f60) return { code, name: data.f58 || code, price: data.f43 / 1000, previousPrice: data.f60 / 1000, dailyChange: data.f170 ? data.f170 / 100 : ((data.f43 - data.f60) / data.f60) * 100, source: "Eastmoney", updatedAt: new Date().toISOString() };
    } catch { /* use Sina fallback below */ }
  }
  try {
    const prefix = code.startsWith("rt_hk") || code.startsWith("gb_") ? "" : code.startsWith("6") || code.startsWith("5") ? "sh" : "sz";
    const requestCode = prefix ? `${prefix}${code}` : code;
    const response = await fetch(`https://hq.sinajs.cn/list=${requestCode}`, { headers: { Referer: "https://finance.sina.com.cn/" }, signal: timeout(3000) });
    if (!response.ok) return null;
    const text = new TextDecoder("gbk").decode(await response.arrayBuffer());
    const payload = text.match(/="([\s\S]*)";/)?.[1]?.split(",");
    if (!payload || payload.length < 4) return null;
    const price = code.startsWith("rt_hk") ? number(payload[6]) : code.startsWith("gb_") ? number(payload[1]) : number(payload[3]);
    const previous = code.startsWith("rt_hk") ? number(payload[3]) : code.startsWith("gb_") ? number(payload[1]) - number(payload[2]) : number(payload[2]);
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
  const [nav, ownQuote, penetration] = await Promise.all([position.code === "000759" ? Promise.resolve(cashFundQuote(position.code)) : position.type === "fund" ? fundNav(position.code) : Promise.resolve(null), position.type === "etf" ? stockQuote(position.code) : Promise.resolve(null), dailyPenetration(position)]);
  const quotes = Object.fromEntries((await Promise.all(fetchCodes(penetration).map(async (code) => [code, await stockQuote(code)] as const))).filter((entry): entry is readonly [string, Quote] => Boolean(entry[1])).map(([code, quote]) => [code, { price: quote.price, dailyChange: quote.dailyChange }]));
  const resolved = applyUnderlyingQuotes(penetration, quotes);
  const updated = {
    ...position,
    currentPrice: nav?.price ?? ownQuote?.price ?? position.currentPrice,
    previousPrice: nav?.previousPrice ?? ownQuote?.previousPrice ?? position.previousPrice,
    dailyChange: resolved.estimatedChange ?? nav?.dailyChange ?? ownQuote?.dailyChange ?? position.dailyChange,
    penetration: resolved,
    lookThrough: resolved.holdings,
    updatedAt: new Date().toISOString(),
  };
  return markToMarket(updated, {
    price: updated.currentPrice ?? 0,
    previousPrice: updated.previousPrice,
    dailyChange: updated.dailyChange ?? 0,
  }, updated.dailyChange ?? 0);
}

export async function refreshQuotes(positions: Position[]): Promise<Position[]> {
  return Promise.all(positions.map(async (position) => {
    try {
      if (position.type === "cash") return markToMarket(position, await cashQuote(position.code, position.name));
      if (position.type === "fund" || position.type === "etf") return await refreshFund(position);
        const quote = await stockQuote(position.type === "stock" && /^0\d{4}$/.test(position.code) ? `rt_hk${position.code}` : position.code);
      return quote ? markToMarket(position, quote) : position;
    } catch {
      return position;
    }
  }));
}

export async function refreshLiveQuotes(positions: Position[]): Promise<Position[]> {
  return Promise.all(positions.map(async (position) => {
    try {
      if (position.type === "cash") return markToMarket(position, await cashQuote(position.code, position.name));
      if (position.type === "crypto") {
        const quote = await cryptoQuote(position.code);
        if (!quote) return position;
        return markToMarket(position, quote);
      }
      if (position.type === "fund") {
        const nav = position.code === "000759" ? cashFundQuote(position.code) : await fundNav(position.code);
        const basePenetration = await dailyPenetration(position);
        const quotes = Object.fromEntries((await Promise.all(fetchCodes(basePenetration).map(async (code) => [code, await stockQuote(code)] as const))).filter((entry): entry is readonly [string, Quote] => Boolean(entry[1])).map(([code, quote]) => [code, { price: quote.price, dailyChange: quote.dailyChange }]));
        const penetration = applyUnderlyingQuotes(basePenetration, quotes);
        const updated = markToMarket({ ...position, penetration, lookThrough: penetration.holdings }, {
          price: nav?.price ?? position.currentPrice ?? 0,
          previousPrice: nav?.previousPrice ?? position.previousPrice,
          dailyChange: penetration.estimatedChange ?? position.dailyChange ?? 0,
        }, penetration.estimatedChange ?? position.dailyChange ?? 0);
        return updated;
      }
      const quote = await stockQuote(position.type === "stock" && /^0\d{4}$/.test(position.code) ? `rt_hk${position.code}` : position.code);
      if (!quote) return position;
      return markToMarket(position, quote);
    } catch {
      return position;
    }
  }));
}
