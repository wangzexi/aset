import { deletePosition, readPortfolio, upsertPosition, writePortfolio } from "./store";
import { refreshLiveQuotes, refreshQuotes } from "./market-data";
import { calculateExposure } from "./exposure";
import { marketValue } from "./types";
import type { AssetType, Position } from "./types";

const port = Number(Bun.env.PORT ?? 8787);
const publicDir = `${import.meta.dir}/../web/dist`;

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const today = () => new Date().toISOString().slice(0, 10);

function summary(positions: Position[]) {
  return positions.reduce((result, position) => {
    const value = marketValue(position);
    result.marketValue += value;
    result.cost += value;
    result.dailyPnl += position.todayPnl ?? value * ((position.dailyChange ?? 0) / 100);
    result.recurringAmount = (result.recurringAmount ?? 0) + (position.recurring ? position.recurring.amount : 0);
    return result;
  }, { marketValue: 0, cost: 0, dailyPnl: 0, recurringAmount: 0 });
}

async function body(request: Request) {
  try { return await request.json() as Record<string, unknown>; } catch { return null; }
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/portfolio" && request.method === "GET") {
      const portfolio = await readPortfolio();
      return json({ ...portfolio, summary: summary(portfolio.positions), ...calculateExposure(portfolio.positions) });
    }
    if (url.pathname === "/api/portfolio/refresh" && request.method === "POST") {
      const portfolio = await readPortfolio();
      if (portfolio.lastDataSyncDate !== today()) {
        portfolio.positions = await refreshQuotes(portfolio.positions);
        portfolio.lastDataSyncDate = today();
      }
      await writePortfolio(portfolio);
      return json({ ...portfolio, summary: summary(portfolio.positions), ...calculateExposure(portfolio.positions) });
    }
    if (url.pathname === "/api/portfolio/live" && request.method === "POST") {
      const portfolio = await readPortfolio();
      portfolio.positions = await refreshLiveQuotes(portfolio.positions);
      return json({ ...portfolio, summary: summary(portfolio.positions), ...calculateExposure(portfolio.positions) });
    }
    if (url.pathname === "/api/positions" && request.method === "POST") {
      const input = await body(request);
      const position: Position = {
        code: String(input?.code || "").trim(),
        name: String(input?.name || input?.code || "未命名资产").trim(),
        channel: input?.channel == null ? undefined : String(input.channel).trim(),
        type: (input?.type as AssetType) || "fund",
        shares: Number(input?.shares),
        recurring: input?.recurring as Position["recurring"],
      };
      if (!position.code || !["fund", "stock", "etf", "crypto", "cash"].includes(position.type) || !Number.isFinite(position.shares) || position.shares <= 0) {
        return json({ error: "请填写正确的代码、类型和持有份额" }, 400);
      }
      const saved = await upsertPosition(position);
      return json({ ...saved, summary: summary(saved.positions), ...calculateExposure(saved.positions) });
    }
    if (url.pathname.startsWith("/api/positions/") && request.method === "DELETE") {
      const portfolio = await deletePosition(url.pathname.split("/").at(-1) ?? "");
      return json({ ...portfolio, summary: summary(portfolio.positions), ...calculateExposure(portfolio.positions) });
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    const file = url.pathname === "/" ? `${publicDir}/index.html` : `${publicDir}${url.pathname}`;
    const asset = Bun.file(file);
    return (await asset.exists()) ? new Response(asset) : new Response("Not found", { status: 404 });
  },
});

console.log(`投资管理器运行在 http://localhost:${server.port}`);
