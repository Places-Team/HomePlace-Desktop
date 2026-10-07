import { describe, expect, it } from "vitest";
import { groupIncomingFiles, incomingFileCount, incomingHintExpanded, shouldDismissIncomingShelf } from "./incomingShares";

describe("incoming file consent", () => {
  it("shows a compact hint without collapsing an existing interaction", () => {
    expect(incomingHintExpanded(false, true, false)).toBe(false);
    expect(incomingHintExpanded(true, true, false)).toBe(true);
    expect(incomingHintExpanded(false, false, true)).toBe(true);
  });
  it("counts only actionable files and deduplicates legacy offers", () => {
    expect(incomingFileCount([
      { id: "1", kind: "file", sourceName: "Phone" },
      { id: "1", kind: "file", sourceName: "Phone" },
      { id: "2", kind: "text", sourceName: "Phone" },
    ], [
      { status: "offered", files: [{ received: false }, { received: false }] },
      { status: "accepted", files: [{ received: true }, { received: false }] },
      { status: "completed", files: [{ received: true }] },
    ])).toBe(4);
  });
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
