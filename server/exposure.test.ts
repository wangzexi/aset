import { describe, expect, test } from "bun:test";
import { calculateExposure } from "./exposure";

describe("calculateExposure", () => {
  test("uses CNY valuation for HKD shares and aggregates cash as cash", () => {
    const result = calculateExposure([
      {
        code: "HKD",
        name: "港币",
        type: "cash",
        shares: 3428.58,
        assetClass: "cash",
        estimatedAmount: 2952.35709516,
      },
      {
        code: "CNY",
        name: "余额宝",
        type: "cash",
        shares: 339569.43,
        assetClass: "cash",
        estimatedAmount: 339569.43,
      },
    ]).exposures;

    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe("CASH");
    expect(result[0]?.name).toBe("现金");
    expect(result[0]?.amount).toBeCloseTo(342521.78709516, 8);
    expect(result[0]?.portfolioWeight).toBeCloseTo(100, 8);
  });

  test("does not divide a root holding by an extra 100", () => {
    const result = calculateExposure([{
      code: "FUND",
      name: "测试基金",
      type: "fund",
      shares: 100,
      estimatedAmount: 1000,
      penetration: {
        mode: "override",
        source: "test",
        totalWeight: 100,
        holdings: [{ code: "STOCK", name: "测试股票", weight: 100, assetClass: "stock" }],
      },
    }]).exposures;

    expect(result[0]?.amount).toBeCloseTo(1000, 8);
    expect(result[0]?.portfolioWeight).toBeCloseTo(100, 8);
  });

  test("qualifies residual holdings with their owning position", () => {
    const result = calculateExposure([{
      code: "ETF",
      name: "测试科技 ETF",
      type: "fund",
      shares: 100,
      estimatedAmount: 1000,
      penetration: {
        mode: "override",
        source: "test",
        totalWeight: 100,
        holdings: [{ code: "OTHER_ETF", name: "其他成分", weight: 100, assetClass: "stock" }],
      },
    }]).exposures;

    expect(result[0]?.name).toBe("测试科技 ETF的其他成分");
    expect(result[0]?.sources).toEqual(["测试科技 ETF"]);
  });
});
