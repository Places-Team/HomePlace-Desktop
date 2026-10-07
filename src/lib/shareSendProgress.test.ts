import { describe, expect, it } from "vitest";
import { sendProgressPercent } from "./shareSendProgress";

describe("compact send progress", () => {
  it("includes completed files and clamps incomplete progress", () => {
    expect(sendProgressPercent({ transferredBytes: 50, totalBytes: 100, fileIndex: 1, fileCount: 3 })).toBe(50);
    expect(sendProgressPercent({ transferredBytes: 110, totalBytes: 100, fileIndex: 0, fileCount: 1 })).toBe(100);
  });
  it("starts at zero while preparing", () => {
    expect(sendProgressPercent(null)).toBe(0);
    expect(sendProgressPercent({ transferredBytes: 0, totalBytes: 0, fileIndex: 0, fileCount: 2 })).toBe(0);
  });
});
