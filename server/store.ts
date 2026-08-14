import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Portfolio, Position } from "./types";

const file = join(import.meta.dir, "..", "data", "config.json");

const emptyPortfolio = (): Portfolio => ({
  positions: [],
});

type StoredPosition = Pick<Position, "code" | "name" | "channel" | "type" | "shares" | "recurring" | "underlying">;

function storedPosition(position: Position): StoredPosition {
  return {
    code: position.code,
    name: position.name,
    ...(position.channel ? { channel: position.channel } : {}),
    type: position.type,
    shares: position.shares,
    ...(position.underlying ? { underlying: position.underlying } : {}),
    ...(position.recurring ? { recurring: position.recurring } : {}),
  };
}

export async function readPortfolio(): Promise<Portfolio> {
  try {
    const portfolio = await Bun.file(file).json() as Portfolio;
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
