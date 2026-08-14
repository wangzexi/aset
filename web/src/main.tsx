import { StrictMode, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { layoutWithLines, prepareWithSegments } from "@chenglou/pretext";
import "./styles.css";

type Holding = { code: string; name: string; weight: number; dailyChange?: number; contribution?: number; sector?: string; assetClass?: string };
type Position = { code: string; name: string; type?: string; channel?: string; amount?: number; shares: number; estimatedAmount?: number; dailyChange?: number; todayPnl?: number; recurring?: { amount: number; nextDate: string; maxAmount?: number }; penetration?: { mode: string; source: string; reportDate?: string; totalWeight: number; holdings: Holding[] } };
type State = { positions: Position[]; summary: { marketValue: number; cost: number; dailyPnl: number; recurringAmount: number }; exposures: Array<{ code: string; name: string; sector: string; assetClass?: "stock" | "cash" | "bond" | "gold" | "crypto"; amount: number; portfolioWeight: number; dailyChange: number; todayPnl: number; sources: string[] }>; updatedAt?: string };
type Identity = "cash" | "bond" | "stock" | "gold" | "crypto";
type ViewPreferences = { compositionMetric: CompositionMetric; identities: Identity[]; channels?: string[]; valuationLevel?: "positions" | "underlying"; returnsLevel?: "positions" | "underlying"; valuationDisplay?: "percentage" | "value"; returnsDisplay?: "percentage" | "value" };
const preferenceKey = "investment-manager-view-preferences";
function readPreferences(): ViewPreferences | null {
  try {
    const raw = localStorage.getItem(preferenceKey);
    return raw ? JSON.parse(raw) as ViewPreferences : null;
  } catch { return null; }
}

const money = (value = 0) => Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (value = 0) => (value >= 0 ? "+" : "") + value.toFixed(2) + "%";
const tone = (value = 0) => value >= 0 ? "positive" : "negative";
function Money({ value }: { value?: number }) {
  const parts = money(value).match(/^(.*)(\.\d{2})$/);
  return parts ? <>{parts[1]}<span className="minor-amount">{parts[2]}</span></> : money(value);
}
const sharesLabel = (position: Position) => position.type === "crypto" ? "实际数量" : position.type === "stock" ? "持有股数" : "份额";
const sharesValue = (position: Position) => position.shares.toLocaleString("zh-CN", position.type === "crypto" ? { maximumFractionDigits: 8 } : position.type === "stock" ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const positionIdentity = (position: Position): Identity => position.type === "cash" || position.type === "crypto" || position.code === "BTC" || position.code === "WBETH" ? (position.type === "cash" ? "cash" : "crypto") : position.code === "000759" || position.name.includes("货币") ? "cash" : position.code === "019396" || position.name.includes("债券") ? "bond" : position.name.includes("黄金") ? "gold" : "stock";
const sourceLabel = (source: string) => source
  .replace("fund prospectus allocation (95% target ETF + 5% cash)", "基金招募说明书配置（目标 ETF 95% + 现金 5%）")
  .replace("fund allocation estimate (95% target ETF + 5% cash)", "基金资产配置估算（目标 ETF 95% + 现金 5%）")
  .replace("manual ETF mapping", "手工 ETF 映射")
  .replace("HSTECH official factsheet constituent fallback", "恒生科技官方成分股")
  .replace("Eastmoney quarterly holdings", "天天基金季度持仓")
  .replace("Eastmoney", "天天基金");

type CompositionMetric = "amount" | "todayPnl";
type CompositionDisplay = "percentage" | "value";
type CompositionItem = { label: string; code?: string; source?: string; assetClass?: Identity; shares?: { label: string; value: string }; recurring?: string; amount: number; totalAmount?: number; change?: number; todayPnl?: number };
type Rect = CompositionItem & { uid: string; x: number; y: number; width: number; height: number };
type CompositionTextLayout = { lines: string[]; fontSize: number; lineHeight: number; padding: { x: number; y: number } };
const compositionPadding = (width: number, height: number) => ({
  x: Math.min(8, Math.max(1, width * 0.03)),
  y: Math.min(8, Math.max(2, height * 0.04)),
});
const compositionLines = (label: string, width: number, height: number) => {
  const maxWidth = Math.max(8, width);
  const fontSize = Math.max(6, Math.min(15, Math.min(width / 8, height / 3.4, 220 / Math.max(label.length, 10))));
  const cjkWidth = Math.max(5, fontSize * 1.08);
  const latinWidth = Math.max(4, fontSize * 0.58);
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const char of label) {
    const charWidth = /[^\x00-\xff]/.test(char) ? cjkWidth : latinWidth;
    if (line && used + charWidth > maxWidth) {
      lines.push(line);
      line = "";
      used = 0;
    }
    line += char;
    used += charWidth;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [label];
};

function measureCompositionText(rect: Rect): CompositionTextLayout {
  const padding = compositionPadding(rect.width, rect.height);
  const availableWidth = Math.max(8, rect.width - padding.x * 2);
  const availableHeight = Math.max(20, rect.height - padding.y * 2);
  const maxFontSize = Math.max(6, Math.min(15, rect.width / 8, rect.height / 3.4, 220 / Math.max(rect.label.length, 10)));
  for (let fontSize = maxFontSize; fontSize >= 6; fontSize -= 0.5) {
    const lineHeight = Math.max(8, fontSize * 1.3);
    const prepared = prepareWithSegments(rect.label, `700 ${fontSize}px ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif`);
    const layout = layoutWithLines(prepared, availableWidth, lineHeight);
    const valueHeight = rect.width > 22 && rect.height > 22 ? Math.max(6, Math.min(13, (fontSize - 1) * (rect.width < 45 ? 0.82 : 1))) + 4 : 0;
    if (layout.height + valueHeight <= availableHeight || fontSize === 6) return { lines: layout.lines.map((line) => line.text), fontSize, lineHeight, padding };
  }
  return { lines: [rect.label], fontSize: 6, lineHeight: 8, padding };
}

function layoutRects(items: CompositionItem[], width: number, height: number): Rect[] {
  if (!items.length) return [];
  const root = hierarchy<{ children: CompositionItem[] } | CompositionItem>({ children: items }, (node) => "children" in node ? node.children : undefined)
    .sum((node) => "amount" in node ? node.amount : 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const layoutRoot = treemap<{ children: CompositionItem[] } | CompositionItem>()
    .size([width, height])
    .paddingInner(1)
    .tile(treemapSquarify)(root);
  return layoutRoot.leaves().map((node, index) => { const item = node.data as CompositionItem; return { ...item, uid: `${item.code ?? item.label}-${index}`, x: node.x0, y: node.y0, width: node.x1 - node.x0, height: node.y1 - node.y0 }; });
}

function CompositionArea({ items, metric, display }: { items: CompositionItem[]; metric: CompositionMetric; display: CompositionDisplay }) {
  const clipPrefix = useId().replace(/:/g, "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<Rect | null>(null);
  const [chartSize, setChartSize] = useState({ width: 1000, height: 420 });
  const [pointer, setPointer] = useState({ x: 0, y: 0, width: 0, height: 0, screenX: 0, screenY: 0, viewportWidth: 0, viewportHeight: 0 });
  const chartItems = items.map((item) => ({ ...item, amount: metric === "todayPnl" ? Math.abs(item.todayPnl ?? 0) : item.amount }));
  const filtered = chartItems.filter((item) => item.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = filtered.reduce((sum, item) => sum + item.amount, 0);
  const totalAmount = items.reduce((sum, item) => sum + (item.totalAmount ?? item.amount), 0);
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const updateSize = () => {
      const width = Math.max(1, Math.round(element.clientWidth));
      setChartSize({ width, height: Math.max(180, Math.min(420, Math.round(width * 0.42))) });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rects = layoutRects(filtered, chartSize.width, chartSize.height);
  const tooltipWidth = Math.min(360, Math.max(230, pointer.width - 16));
  const tooltipHeight = 220;
  const tooltipLeft = Math.min(Math.max(pointer.screenX + 14, 8), Math.max(8, pointer.viewportWidth - tooltipWidth - 8));
  const tooltipAbove = pointer.screenY + tooltipHeight + 14 > pointer.viewportHeight;
  const tooltipTop = tooltipAbove ? pointer.screenY - 14 : pointer.screenY + 14;
  return <div className="composition-wrap" ref={wrapRef}>
    <svg className="composition-area" style={{ height: `${chartSize.height}px` }} viewBox={`0 0 ${chartSize.width} ${chartSize.height}`} preserveAspectRatio="none" role="img" aria-label="资产结构面积图" onMouseMove={(event) => { const bounds = event.currentTarget.getBoundingClientRect(); setPointer({ x: event.clientX - bounds.left, y: event.clientY - bounds.top, width: bounds.width, height: bounds.height, screenX: event.clientX, screenY: event.clientY, viewportWidth: document.documentElement.clientWidth, viewportHeight: document.documentElement.clientHeight }); }} onMouseLeave={() => setHovered(null)}>
      <defs>{rects.map((rect, index) => <clipPath id={`${clipPrefix}-clip-${index}`} key={index}><rect x={rect.x + 1} y={rect.y + 1} width={Math.max(rect.width - 2, 0)} height={Math.max(rect.height - 2, 0)}/></clipPath>)}</defs>
    {rects.map((rect, rectIndex) => { const padding = compositionPadding(rect.width, rect.height); const lines = compositionLines(rect.label, Math.max(rect.width - padding.x * 2, 8), Math.max(rect.height - padding.y * 2, 8)); const textX = rect.x + padding.x; const textY = rect.y + padding.y + Math.max(6, Math.min(15, Math.min(rect.width / 8, rect.height / 3.4))); const labelSize = Math.max(6, Math.min(15, Math.min(rect.width / 8, rect.height / 3.4, 220 / Math.max(rect.label.length, 10)))); const valueSize = Math.max(6, Math.min(13, labelSize - 1)); const lineHeight = Math.max(8, labelSize * 1.35); const fill = metric === "amount" ? (rect.assetClass === "cash" ? "#10b981" : rect.assetClass === "bond" ? "#06b6d4" : rect.assetClass === "gold" ? "#f59e0b" : rect.assetClass === "crypto" ? "#8b5cf6" : "#3b82f6") : (rect.change == null || rect.change >= 0 ? "#ef4444" : "#10b981"); return <g key={rect.uid} onMouseEnter={() => setHovered(rect)} onMouseLeave={() => setHovered(null)}><rect className={`composition-rect${hovered?.uid === rect.uid ? " hovered" : ""}`} x={rect.x} y={rect.y} width={rect.width} height={rect.height} fill={fill} fillOpacity={1}/><g clipPath={`url(#${clipPrefix}-clip-${rectIndex})`}>{rect.width > 12 && rect.height > 14 ? lines.map((line, index) => <text key={index} className="composition-label" style={{ fontSize: labelSize }} x={rect.width > 20 ? textX : rect.x + rect.width / 2} y={rect.width > 20 ? textY + index * lineHeight : rect.y + rect.height / 2 + labelSize / 3} textAnchor={rect.width > 20 ? "start" : "middle"}>{line}</text>) : null}{rect.width > 22 && rect.height > 22 && <text className="composition-value" style={{ fontSize: Math.max(5, valueSize * (rect.width < 45 ? 0.82 : 1)) }} x={textX} y={textY + lines.length * lineHeight}>{display === "value" ? `¥${money(metric === "amount" ? rect.amount : rect.todayPnl)}` : metric === "amount" ? (rect.amount / total * 100).toFixed(2) + "%" : pct(rect.change)}</text>}</g></g>; })}
   </svg>
    <div className="composition-label-layer" aria-hidden="true">{rects.map((rect) => { const layout = measureCompositionText(rect); const showValue = rect.width > 22 && rect.height > 22; const valueSize = Math.max(5, Math.min(13, (layout.fontSize - 1) * (rect.width < 45 ? 0.82 : 1))); return <div key={`label-${rect.uid}`} className="composition-label-overlay" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, padding: `${layout.padding.y}px ${layout.padding.x}px`, justifyContent: "flex-start", alignItems: "flex-start" }}><div className="composition-label-content"><div className="composition-label-html" style={{ fontSize: `${layout.fontSize}px`, lineHeight: `${layout.lineHeight}px` }}>{layout.lines.map((line, index) => <div key={index}>{line}</div>)}</div>{showValue && <div className={`composition-value-html ${metric === "todayPnl" ? tone(rect.todayPnl) : ""}`} style={{ fontSize: `${valueSize}px`, lineHeight: `${valueSize + 3}px` }}>{display === "value" ? `¥${money(metric === "amount" ? rect.amount : rect.todayPnl)}` : metric === "amount" ? (rect.amount / total * 100).toFixed(2) + "%" : pct(rect.change)}</div>}</div></div>; })}</div>
    {hovered && <div className="composition-tooltip" style={{ position: "fixed", width: `${tooltipWidth}px`, left: `${tooltipLeft}px`, top: `${tooltipTop}px`, transform: tooltipAbove ? "translateY(-100%)" : undefined }}><div className="composition-tooltip-title"><b>{hovered.label}</b>{hovered.code && <span className="label">{hovered.code}</span>}</div><div className="composition-tooltip-primary"><div className="composition-tooltip-row"><span>实时估值</span><span className="tooltip-metric"><span>{money(hovered.totalAmount ?? hovered.amount)}</span><i className="tooltip-slash">/</i><span>{totalAmount ? ((hovered.totalAmount ?? hovered.amount) / totalAmount * 100).toFixed(2) : "0.00"}%</span></span></div><div className="composition-tooltip-row"><span>今日收益</span><span className={`tooltip-metric ${tone(hovered.todayPnl)}`}><span>{money(hovered.todayPnl)}</span><i className="tooltip-slash">/</i><span>{pct(hovered.change)}</span></span></div></div><div className="composition-tooltip-divider"/><div className="composition-tooltip-secondary">{hovered.source && <div className="composition-tooltip-row"><span>来源</span><span className="tooltip-source">{hovered.source}</span></div>}{hovered.shares && <div className="composition-tooltip-row"><span>{hovered.shares.label}</span><span>{hovered.shares.value}</span></div>}{hovered.recurring && <div className="composition-tooltip-row"><span>定投</span><span className="tooltip-source">{hovered.recurring}</span></div>}</div></div>}
  </div>;
}

function App() {
  const [state, setState] = useState<State | null>(null);
  const [preferences] = useState(() => readPreferences());
  const [compositionMetric] = useState<CompositionMetric>("amount");
  const [valuationLevel, setValuationLevel] = useState<"positions" | "underlying">(preferences?.valuationLevel === "underlying" ? "underlying" : "positions");
  const [returnsLevel, setReturnsLevel] = useState<"positions" | "underlying">(preferences?.returnsLevel === "underlying" ? "underlying" : "positions");
  const [valuationDisplay, setValuationDisplay] = useState<CompositionDisplay>(preferences?.valuationDisplay === "value" ? "value" : "percentage");
  const [returnsDisplay, setReturnsDisplay] = useState<CompositionDisplay>(preferences?.returnsDisplay === "value" ? "value" : "percentage");
  const [identities, setIdentities] = useState<Identity[]>(preferences?.identities?.filter((item): item is Identity => ["cash", "bond", "stock", "gold", "crypto"].includes(item)) ?? ["cash", "bond", "stock", "gold", "crypto"]);
  const [channels, setChannels] = useState<string[] | null>(preferences?.channels ?? null);
  const toggleIdentity = (value: Identity) => setIdentities((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  const toggleChannel = (value: string) => setChannels((current) => { const selected = current ?? availableChannels; return selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]; });
  const load = async (path: string) => {
    const response = await fetch(path, { method: "POST" });
    if (!response.ok) throw new Error("同步失败");
    const next = await response.json() as State;
    setState(next);
  };
  useEffect(() => {
    load("/api/portfolio/refresh").then(() => load("/api/portfolio/live")).catch(console.error);
    const timer = setInterval(() => load("/api/portfolio/live").catch(console.error), 3000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!state) return;
    const available = [...new Set(state.positions.map((position) => position.channel || "未记录"))];
    setChannels((current) => current ?? available);
    const selected = channels ?? available;
    localStorage.setItem(preferenceKey, JSON.stringify({ compositionMetric, identities, channels: selected, valuationLevel, returnsLevel, valuationDisplay, returnsDisplay } satisfies ViewPreferences));
  }, [state, compositionMetric, identities, channels, valuationLevel, returnsLevel, valuationDisplay, returnsDisplay]);
  if (!state) return <main><div className="empty">正在加载…</div></main>;
  const channelOrder = ["支付宝", "众安", "币安"];
  const availableChannels = [...new Set(state.positions.map((position) => position.channel || "未记录"))].sort((a, b) => (channelOrder.indexOf(a) === -1 ? 99 : channelOrder.indexOf(a)) - (channelOrder.indexOf(b) === -1 ? 99 : channelOrder.indexOf(b)));
  const selectedChannels = channels ?? availableChannels;
  const selectedPositionNames = new Set(state.positions.filter((position) => selectedChannels.includes(position.channel || "未记录")).map((position) => position.name));
  const positions = state.positions.filter((position) => identities.includes(positionIdentity(position)) && selectedChannels.includes(position.channel || "未记录"));
  const exposures = state.exposures.filter((exposure) => identities.includes(exposure.assetClass ?? "stock") && exposure.sources.some((source) => selectedPositionNames.has(source)));
  const filteredSummary = { marketValue: positions.reduce((sum, position) => sum + (position.estimatedAmount ?? position.amount ?? 0), 0), dailyPnl: positions.reduce((sum, position) => sum + (position.todayPnl ?? 0), 0) };
  const positionsTotal = filteredSummary.marketValue;
  const recurringText = (position: Position) => position.recurring ? `每日 ${money(position.recurring.amount)}` : undefined;
  const positionComposition = positions.map((position) => ({ label: position.name, code: position.code, source: position.channel || "未记录", assetClass: positionIdentity(position), shares: { label: sharesLabel(position), value: sharesValue(position) }, recurring: recurringText(position), amount: position.estimatedAmount ?? position.amount ?? 0, totalAmount: position.estimatedAmount ?? position.amount ?? 0, change: position.dailyChange, todayPnl: position.todayPnl }));
  const underlyingComposition = exposures.map((exposure) => { const relatedPositions = positions.filter((position) => position.code === exposure.code || position.penetration?.holdings.some((holding) => holding.code === exposure.code)); return { label: exposure.name, code: exposure.code, source: relatedPositions.map((position) => `${position.name} / ${position.channel || "未记录"}`).join("\n") || exposure.sources.join("\n"), assetClass: exposure.assetClass, amount: exposure.amount, totalAmount: exposure.amount, change: exposure.dailyChange, todayPnl: exposure.todayPnl }; });
  return <main>
    <div className="filter-panel">
      <div className="filter-row"><div className="filter-options"><button type="button" aria-pressed={identities.includes("cash")} className={identities.includes("cash") ? "active" : ""} onClick={() => toggleIdentity("cash")}>现金</button><button type="button" aria-pressed={identities.includes("bond")} className={identities.includes("bond") ? "active" : ""} onClick={() => toggleIdentity("bond")}>债券</button><button type="button" aria-pressed={identities.includes("stock")} className={identities.includes("stock") ? "active" : ""} onClick={() => toggleIdentity("stock")}>股票</button><button type="button" aria-pressed={identities.includes("gold")} className={identities.includes("gold") ? "active" : ""} onClick={() => toggleIdentity("gold")}>黄金</button><button type="button" aria-pressed={identities.includes("crypto")} className={identities.includes("crypto") ? "active" : ""} onClick={() => toggleIdentity("crypto")}>加密货币</button></div></div>
      <div className="filter-row"><div className="filter-options">{availableChannels.map((channel) => <button type="button" key={channel} aria-pressed={selectedChannels.includes(channel)} className={selectedChannels.includes(channel) ? "active" : ""} onClick={() => toggleChannel(channel)}>{channel}</button>)}</div></div>
    </div>
    {identities.length > 0 && <>
      <section className="metric-group"><h2>实时估值</h2><div className="metric-total"><Money value={filteredSummary.marketValue}/></div><div className="metric-switch-row"><div className="metric-switch"><button className={valuationLevel === "positions" ? "active" : ""} onClick={() => setValuationLevel("positions")}>原始</button><button className={valuationLevel === "underlying" ? "active" : ""} onClick={() => setValuationLevel("underlying")}>穿透</button></div><div className="metric-switch metric-display-switch"><button aria-label="显示人民币" className={valuationDisplay === "value" ? "active" : ""} onClick={() => setValuationDisplay("value")}>¥</button><button aria-label="显示百分比" className={valuationDisplay === "percentage" ? "active" : ""} onClick={() => setValuationDisplay("percentage")}>%</button></div></div><CompositionArea items={valuationLevel === "positions" ? positionComposition : underlyingComposition} metric="amount" display={valuationDisplay}/></section>
      <section className="metric-group"><h2>今日收益</h2><div className={"metric-total " + tone(filteredSummary.dailyPnl)}><Money value={filteredSummary.dailyPnl}/></div><div className="metric-switch-row"><div className="metric-switch"><button className={returnsLevel === "positions" ? "active" : ""} onClick={() => setReturnsLevel("positions")}>原始</button><button className={returnsLevel === "underlying" ? "active" : ""} onClick={() => setReturnsLevel("underlying")}>穿透</button></div><div className="metric-switch metric-display-switch"><button aria-label="显示人民币" className={returnsDisplay === "value" ? "active" : ""} onClick={() => setReturnsDisplay("value")}>¥</button><button aria-label="显示百分比" className={returnsDisplay === "percentage" ? "active" : ""} onClick={() => setReturnsDisplay("percentage")}>%</button></div></div><CompositionArea items={returnsLevel === "positions" ? positionComposition : underlyingComposition} metric="todayPnl" display={returnsDisplay}/></section>
    </>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>);
