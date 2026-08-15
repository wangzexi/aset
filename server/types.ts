export type AssetType = "fund" | "stock" | "etf" | "crypto" | "cash";

/** 资产大类：穿透树节点的分类。基础元素（现金/黄金/债券/加密）没有代码。 */
export type AssetClass = "stock" | "etf" | "fund" | "cash" | "gold" | "bond" | "crypto";

/**
 * 穿透树节点：配置、穿透结果、运行时数据共用同一个结构。
 *
 * 配置里（holdings）由 AI 写，只写不可推导的事实：
 *   { "code": "518660", "weight": 90 }        → 指向具体资产（程序自动展开/拉行情）
 *   { "assetClass": "cash", "weight": 10 }    → 基础元素（现金/黄金/债券/加密，无代码）
 *
 * 运行时由程序填充 name/price/dailyChange 等派生数据。
 * children 递归：一个资产 = 若干子资产按 weight 构成，直到叶子。
 */
export type Holding = {
  /** 资产代码；基础元素（现金/黄金/债券）没有 */
  code?: string;
  /** 显示名；配置里可省略，程序用代码查到的名字填充 */
  name?: string;
  /** 占父资产的权重（%），position 根节点视为 100 */
  weight: number;
  assetClass?: AssetClass;
  sector?: string;
  /** 子节点，递归；缺省 = 叶子 */
  children?: Holding[];
  /** —— 以下为运行时字段，程序填充，不要写进配置 —— */
  price?: number;
  dailyChange?: number;
  contribution?: number;
  /** 派生行情查询码，由代码自动推导 */
  _fetchCode?: string;
};

export type Position = {
  code: string;
  /** 显示别名；不写则用代码查到的网络名 */
  name?: string;
  channel?: string;
  type: AssetType;
  shares: number;
  /** 可选：整个持仓归为基础元素（现金/黄金/债券/加密），穿透结果为空时兜底分类 */
  assetClass?: AssetClass;
  /** 可选：实际构成树。code 项指向具体资产（程序自动展开/拉行情），assetClass 项指向基础元素 */
  holdings?: Holding[];
  recurring?: RecurringInvestment;
  /** —— 以下为运行时字段，同步时由程序填充 —— */
  effectiveShares?: number;
  recurringPeriods?: number;
  amount?: number;
  currentPrice?: number;
  previousPrice?: number;
  todayPnl?: number;
  estimatedAmount?: number;
  dailyChange?: number;
  penetration?: Penetration;
};

export type RecurringInvestment = {
  frequency: "daily";
  amount: number;
  nextDate: string;
  /** 当前 shares 已确认到哪一天；之后的确认净值会自动补成份额 */
  sharesAsOf?: string;
  /** 定投申购费率，单位为百分比，例如 0.05 = 0.05% */
  feePercent?: number;
  /** 定投扣款来源的资产代码 */
  fundingCode?: string;
  maxAmount?: number;
  restriction?: string;
};

export type Penetration = {
  /** 穿透方式：auto = 程序自动拉取；override = 配置指定构成；unavailable = 拉不到 */
  mode: "auto" | "override" | "unavailable";
  source: string;
  reportDate?: string;
  totalWeight: number;
  estimatedChange?: number;
  /** 构成树（position 的直接构成，children 递归） */
  holdings: Holding[];
};

export type Portfolio = {
  positions: Position[];
  lastDataSyncDate?: string;
};

export type Quote = {
  code: string;
  name: string;
  price: number;
  previousPrice?: number;
  dailyChange: number;
  source: string;
  updatedAt: string;
  asOfDate?: string;
  navHistory?: Array<{ date: string; price: number }>;
};

export function marketValue(position: Position): number {
  return position.estimatedAmount ?? position.amount ?? (position.effectiveShares ?? position.shares) * (position.currentPrice ?? 0);
}
