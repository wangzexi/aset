import { marketValue } from "./types";
import type { Holding, Position } from "./types";

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

const className: Record<Exposure["assetClass"], string> = {
  stock: "股票",
  cash: "现金",
  bond: "债券",
  gold: "黄金",
  crypto: "加密货币",
};

/** 叶子分类：显式 assetClass → 名称推断 → position 兜底 → 股票 */
function classify(node: Holding, fallback?: Position["assetClass"]): Exposure["assetClass"] {
  if (node.assetClass === "cash" || node.assetClass === "bond" || node.assetClass === "gold" || node.assetClass === "crypto") return node.assetClass;
  const name = node.name ?? "";
  if (node.code === "000759" || node.code === "CASH" || name.includes("货币") || name.includes("现金")) return "cash";
  if (node.code === "019396" || name.includes("债券")) return "bond";
  if (name.includes("黄金")) return "gold";
  if (fallback === "cash" || fallback === "bond" || fallback === "gold" || fallback === "crypto") return fallback;
  return "stock";
}

/** 没有显式配置时，position 整体归属的基础元素分类 */
function fallbackClass(position: Position): Exposure["assetClass"] {
  if (position.type === "cash" || position.code === "000759") return "cash";
  if (position.assetClass === "bond" || position.assetClass === "gold" || position.assetClass === "cash" || position.assetClass === "crypto") return position.assetClass;
  if (position.type === "crypto") return "crypto";
  const name = position.name ?? "";
  if (name.includes("黄金")) return "gold";
  if (name.includes("债券")) return "bond";
  if (name.includes("货币")) return "cash";
  return "stock";
}

export function calculateExposure(positions: Position[]): { exposures: Exposure[] } {
  const total = positions.reduce((sum, item) => sum + marketValue(item), 0);
  const byCode = new Map<string, Exposure>();

  const addLeaf = (leaf: Holding, pathWeight: number, position: Position) => {
    // pathWeight is already a fraction of the position (the root starts at 1),
    // while leaf.weight is a percentage within its parent.
    const amount = marketValue(position) * pathWeight * leaf.weight / 100;
    if (amount <= 0) return;
    const cls = classify(leaf, position.assetClass);
    const code = leaf.code ?? (cls === "cash" ? "CASH" : cls === "gold" ? "GOLD" : cls === "bond" ? "BOND" : "CRYPTO");
    const sourceName = position.name ?? position.code;
    const configuredName = leaf.name ?? (cls === "cash" ? "现金" : className[cls]);
    // Residual holdings are aggregates, not real securities. Make their owner
    // explicit so the chart never presents an ambiguous standalone "other".
    const isResidual = leaf.code?.startsWith("OTHER_") || /^(其余|其他)/.test(configuredName);
    const name = isResidual && !configuredName.endsWith("的其他成分")
      ? `${sourceName}的其他成分`
      : configuredName;
    // 现金不涨跌；黄金等基础元素无行情时继承持仓本身的涨跌
    const dailyChange = cls === "cash" ? 0 : leaf.dailyChange ?? position.dailyChange ?? 0;
    const todayPnl = amount * dailyChange / 100;
    const existing = byCode.get(code);
    if (existing) {
      existing.amount += amount;
      existing.todayPnl += todayPnl;
      existing.dailyChange = existing.amount ? existing.todayPnl / existing.amount * 100 : 0;
      if (!existing.sources.includes(sourceName)) existing.sources.push(sourceName);
    } else {
      byCode.set(code, {
        code,
        name,
        sector: leaf.sector || className[cls],
        assetClass: cls,
        amount,
        portfolioWeight: total ? amount / total * 100 : 0,
        dailyChange,
        todayPnl,
        sources: [sourceName],
      });
    }
  };

  const walk = (node: Holding, pathWeight: number, position: Position) => {
    if (node.children?.length) node.children.forEach((child) => walk(child, pathWeight * node.weight / 100, position));
    else addLeaf(node, pathWeight, position);
  };

  for (const position of positions) {
    // 有穿透结果走树；没有则把整个持仓合成一个叶子（分类兜底）
    const nodes = position.penetration?.holdings?.length
      ? position.penetration.holdings
      : [{
          name: fallbackClass(position) === "cash" ? "现金" : position.name ?? position.code,
          weight: 100,
          assetClass: fallbackClass(position),
          ...(fallbackClass(position) === "stock" ? { code: position.code } : {}),
        } as Holding];
    for (const node of nodes) walk(node, 1, position);
  }

  const exposures = [...byCode.values()].sort((a, b) => b.amount - a.amount).map((item) => ({ ...item, portfolioWeight: total ? item.amount / total * 100 : 0 }));
  return { exposures };
}
