import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Portfolio, Position } from "./types";

const file = join(import.meta.dir, "..", "data", "config.json");

/** config 里用户显式写的 name（code → name），写回时用它，避免运行时网络名落盘 */
const configNames = new Map<string, string>();

const emptyPortfolio = (): Portfolio => ({
  positions: [],
});

type StoredPosition = Pick<Position, "code" | "name" | "channel" | "type" | "shares" | "assetClass" | "recurring" | "holdings">;

function storedPosition(position: Position): StoredPosition {
  const name = configNames.get(position.code);
  return {
    code: position.code,
    ...(name ? { name } : {}),
    ...(position.channel ? { channel: position.channel } : {}),
    type: position.type,
    shares: position.shares,
    ...(position.assetClass ? { assetClass: position.assetClass } : {}),
    ...(position.holdings ? { holdings: position.holdings } : {}),
    ...(position.recurring ? { recurring: position.recurring } : {}),
  };
}

export async function readPortfolio(): Promise<Portfolio> {
  try {
    const portfolio = await Bun.file(file).json() as Portfolio;
    configNames.clear();
    for (const position of portfolio.positions) configNames.set(position.code, position.name ?? "");
    return portfolio;
  } catch {
    return emptyPortfolio();
  }
}

export async function writePortfolio(portfolio: Portfolio): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, JSON.stringify({ positions: portfolio.positions.map(storedPosition) }, null, 2));
}

export async function upsertPosition(position: Position): Promise<Portfolio> {
  const portfolio = await readPortfolio();
  configNames.set(position.code, position.name ?? "");
  const index = portfolio.positions.findIndex((item) => item.code === position.code);
  if (index >= 0) portfolio.positions[index] = position;
  else portfolio.positions.push(position);
  await writePortfolio(portfolio);
  return portfolio;
}

export async function deletePosition(code: string): Promise<Portfolio> {
  const portfolio = await readPortfolio();
  portfolio.positions = portfolio.positions.filter((item) => item.code !== code);
  await writePortfolio(portfolio);
  return portfolio;
}
