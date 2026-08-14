export type AssetType = "fund" | "stock" | "etf" | "crypto" | "cash";

/** User-maintained look-through config for feeder funds: which ETF the fund tracks.
 *  Only irreducible facts live here; everything else is derived. */
export type UnderlyingConfig = {
  /** Target ETF code, e.g. "513130". Market prefix is derived from the code. */
  target: string;
  sector?: string;
  assetClass?: PenetrationHolding["assetClass"];
  /** Manual constituent fallback when the ETF has no public holdings API. */
  fallbackHoldings?: Array<{ code: string; weight: number }>;
};

export type Position = {
  code: string;
  name: string;
  channel?: string;
  type: AssetType;
  shares: number;
  underlying?: UnderlyingConfig;
  /** Runtime-only fields populated from market data. */
  amount?: number;
  currentPrice?: number;
  previousPrice?: number;
  todayPnl?: number;
  estimatedAmount?: number;
  recurring?: RecurringInvestment;
  dailyChange?: number;
  penetration?: Penetration;
  lookThrough?: PenetrationHolding[];
};

export type RecurringInvestment = {
  frequency: "daily";
  amount: number;
  nextDate: string;
  maxAmount?: number;
  restriction?: string;
};

export type PenetrationHolding = {
  code: string;
  name: string;
  weight: number;
  price?: number;
  dailyChange?: number;
  contribution?: number;
  sector?: string;
  assetClass?: "stock" | "etf" | "commodity" | "crypto" | "cash";
  /** Derived quote request code, never persisted in user config. */
  _fetchCode?: string;
};

export type Penetration = {
  mode: "top10" | "feeder-etf" | "unavailable";
  source: string;
  reportDate?: string;
  totalWeight: number;
  estimatedChange?: number;
  underlyingCode?: string;
  holdings: PenetrationHolding[];
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
};

export function marketValue(position: Position): number {
  return position.estimatedAmount ?? position.amount ?? position.shares * (position.currentPrice ?? 0);
}
