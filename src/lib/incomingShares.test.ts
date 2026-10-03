import { describe, expect, it } from "vitest";
import { groupIncomingFiles, shouldDismissIncomingShelf } from "./incomingShares";

describe("incoming file consent", () => {
  it("dismisses a resolved inbox, but not a new empty shelf", () => {
    expect(shouldDismissIncomingShelf(true, false, false, false, false)).toBe(true);
    expect(shouldDismissIncomingShelf(false, false, false, false, false)).toBe(false);
  });
  it("preserves pending consent, active work, outgoing drafts and errors", () => {
    expect(shouldDismissIncomingShelf(true, true, false, false, false)).toBe(false);
    expect(shouldDismissIncomingShelf(true, false, true, false, false)).toBe(false);
    expect(shouldDismissIncomingShelf(true, false, false, true, false)).toBe(false);
    expect(shouldDismissIncomingShelf(true, false, false, false, true)).toBe(false);
  });
  it("groups pending files by sender without accepting later arrivals", () => {
    const offers = [
      { id: "1", kind: "file", sourceName: "Phone" },
      { id: "2", kind: "file", sourceName: "Phone" },
      { id: "3", kind: "text", sourceName: "Phone" },
      { id: "4", kind: "file", sourceName: "Other" },
    ];
    const groups = groupIncomingFiles(offers);
    expect(groups.map(g => g.files.map(f => f.id))).toEqual([["1", "2"], ["4"]]);
    offers.push({ id: "5", kind: "file", sourceName: "Phone" });
    expect(groups[0].files.map(f => f.id)).toEqual(["1", "2"]);
  });
  it("deduplicates repeated offer identifiers", () => {
    const file = { id: "1", kind: "file", sourceName: "Phone" };
    expect(groupIncomingFiles([file, file])[0].files).toHaveLength(1);
  });
});
