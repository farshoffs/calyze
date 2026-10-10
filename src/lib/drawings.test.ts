import { describe, expect, it } from "vitest";
import {
  DRAWING_GROUPS, FIB_RATIOS, defaultDrawing,
  measureMove, moveDrawing, parseDrawings, pointsFor, projectLine, updateAnchor
} from "./drawings";

const a = { time: 1767225600, price: 90 };
const b = { time: 1767226500, price: 93 };

describe("drawing toolkit", () => {
  it("offers a grouped toolbox with at least twenty different drawing modes", () => {
    expect(DRAWING_GROUPS.flatMap((group) => group.tools).length).toBeGreaterThanOrEqual(20);
    expect(pointsFor("channel")).toBe(3);
    expect(pointsFor("horizontal")).toBe(1);
    expect(pointsFor("fib")).toBe(2);
    expect(pointsFor("brush")).toBe(-1);
    expect(FIB_RATIOS).toContain(0.618);
  });

  it("keeps price/time anchors independent of chart pixels", () => {
    const item = defaultDrawing("trend", [a, b], "#fff", 2, "solid");
    expect(updateAnchor(item, 1, { ...b, price: 95 }).anchors[1].price).toBe(95);
    expect(moveDrawing(item, 3600, -2).anchors[0])
      .toEqual({ time: a.time + 3600, price: a.price - 2 });
    expect(parseDrawings([item])).toHaveLength(1);
    expect(parseDrawings([{ ...item, anchors: [{ time: "bad", price: 1 }] }])).toHaveLength(0);
  });

  it("extends rays in the same direction, and both ways for extended lines", () => {
    const start = { x: 20, y: 50 };
    const end = { x: 40, y: 30 };
    const ray = projectLine(start, end, "ray", 900);
    const extended = projectLine(start, end, "extended", 900);
    expect(ray[0]).toEqual(start);
    expect(ray[1].x).toBeGreaterThan(900);
    expect(extended[0].x).toBeLessThan(0);
    expect(extended[1].y).toBeLessThan(30);
  });

  it("reports ruler price, percentage and elapsed minutes", () => {
    expect(measureMove(a, b)).toEqual({
      priceDelta: 3,
      percentage: 100 * 3 / 90,
      minutes: 15
    });
  });
});
