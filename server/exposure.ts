import { marketValue } from "./types";
import type { PenetrationHolding, Position } from "./types";

export type Exposure = {
  code: string;
  name: string;
  sector: string;
  assetClass: "stock" | "cash" | "bond" | "gold" | "crypto";
  amount: number;
  portfolioWeight: number;
  dailyChange: number;
  todayPnl: number;
  sources: string[];
};

export function calculateExposure(positions: Position[]): { exposures: Exposure[]; unresolved: Position[] } {
  const total = positions.reduce((sum, item) => sum + marketValue(item), 0);
  const byCode = new Map<string, Exposure>();
  const unresolved: Position[] = [];
  for (const position of positions) {
    const isCashFund = position.type === "fund" && (position.code === "000759" || position.name.includes("货币"));
    const isCash = position.type === "cash";
    const isBondFund = position.type === "fund" && (position.code === "019396" || position.name.includes("债券"));
    const isGoldFund = position.type === "fund" && position.name.includes("黄金");
    const isCrypto = position.type === "crypto";
    const holdings = isCashFund || isCash
      ? [{ code: "CASH", name: "现金", weight: 100, sector: "现金", assetClass: "cash" as const, dailyChange: position.dailyChange ?? 0 }]
      : position.lookThrough?.length
        ? position.lookThrough
      : isCrypto
        ? [{ code: position.code, name: position.name, weight: 100, sector: "加密货币", assetClass: "crypto" as const, dailyChange: position.dailyChange ?? 0 }]
      : position.type === "stock"
        ? [{ code: position.code, name: position.name, weight: 100, sector: "未分类" }]
        : [{
            code: position.code,
            name: position.name,
            weight: 100,
            sector: isBondFund ? "债券" : isGoldFund ? "黄金" : "未穿透",
            assetClass: isBondFund ? "bond" : isGoldFund ? "gold" : "stock",
            dailyChange: position.dailyChange ?? 0,
          }];
    if (!holdings.length) { unresolved.push(position); continue; }
    const weightTotal = holdings.reduce((sum, item) => sum + item.weight, 0) || 100;
    for (const holding of holdings) {
      const amount = marketValue(position) * holding.weight / weightTotal;
      const dailyChange = holding.dailyChange ?? 0;
      const todayPnl = amount * dailyChange / 100;
      const existing = byCode.get(holding.code);
      if (existing) {
        existing.amount += amount;
        existing.todayPnl += todayPnl;
        existing.dailyChange = existing.amount ? existing.todayPnl / existing.amount * 100 : 0;
        if (!existing.sources.includes(position.name)) existing.sources.push(position.name);
      } else {
        byCode.set(holding.code, { code: holding.code, name: holding.name, sector: holding.sector || "未分类", assetClass: holding.assetClass === "cash" ? "cash" : holding.assetClass === "commodity" ? "gold" : holding.assetClass === "crypto" ? "crypto" : holding.assetClass === "bond" ? "bond" : "stock", amount, portfolioWeight: total ? amount / total * 100 : 0, dailyChange, todayPnl, sources: [position.name] });
      }
    }
  }
  const exposures = [...byCode.values()].sort((a, b) => b.amount - a.amount).map((item) => ({ ...item, portfolioWeight: total ? item.amount / total * 100 : 0 }));
  return { exposures, unresolved };
}
