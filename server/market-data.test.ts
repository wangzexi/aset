import { expect, test } from "bun:test";
import { calculateEffectiveShares, providerCode } from "./market-data";
import type { Position, Quote } from "./types";

test("把五位港股代码交给各数据源时保持港股市场", () => {
  expect(providerCode("09999", "tencent")).toBe("hk09999");
  expect(providerCode("rt_hk03690", "tencent")).toBe("hk03690");
  expect(providerCode("hk00700", "eastmoney")).toBe("116.00700");
  expect(providerCode("09618", "sina")).toBe("hk09618");
});

test("A 股和美股代码不被误判成港股", () => {
  expect(providerCode("513130", "tencent")).toBe("sh513130");
  expect(providerCode("510300", "eastmoney")).toBe("1.510300");
  expect(providerCode("gb_nvda", "tencent")).toBe("gb_nvda");
});

test("按确认净值和手续费自动补定投份额", () => {
  const position: Position = {
    code: "TEST",
    type: "fund",
    shares: 100,
    recurring: { frequency: "daily", amount: 10, sharesAsOf: "2026-08-12", nextDate: "2026-08-13", feePercent: 5 },
  };
  const nav: Quote = {
    code: "TEST",
    name: "测试基金",
    price: 4,
    previousPrice: 2,
    dailyChange: 100,
    source: "test",
    updatedAt: "2026-08-15T00:00:00.000Z",
    navHistory: [
      { date: "2026-08-12", price: 1 },
      { date: "2026-08-13", price: 2 },
      { date: "2026-08-14", price: 4 },
      { date: "2026-08-15", price: 8 },
    ],
  };
  expect(calculateEffectiveShares(position, nav, "2026-08-14")).toBeCloseTo(107.125, 8);
});
