import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { sendShared } from "./sharedTransfers";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("shared sender", () => {
  const stop = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(listen).mockResolvedValue(stop);
  });
  it("uses one operation for files and completes the shared record", async () => {
    await sendShared({ kind: "files", paths: ["C:/one.txt", "C:/two.txt"] }, { id: "mac", name: "Mac" });
    const start = vi.mocked(invoke).mock.calls.find(([command]) => command === "start_shared_transfer")!;
    const args = start[1] as { id: string; names: string[] };
    expect(args.names).toEqual(["one.txt", "two.txt"]);
    const files = vi.mocked(invoke).mock.calls.filter(([command]) => command === "send_share_file");
    expect(files).toHaveLength(2);
    expect(files.every(([, options]) => (options as { operationId: string }).operationId === args.id)).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("update_shared_transfer", expect.objectContaining({ id: args.id, status: "sent" }));
    expect(stop).toHaveBeenCalledTimes(2);
  });
  it("does not send when another window owns the sender", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("Already active");
    await expect(sendShared({ kind: "text", value: "hello" }, { id: "mac", name: "Mac" })).rejects.toBe("Already active");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("records cancellation and removes the progress listener", async () => {
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === "send_share_file") throw "The transfer was cancelled.";
      return undefined;
    });
    await expect(sendShared({ kind: "files", paths: ["C:/one.txt"] }, { id: "mac", name: "Mac" })).rejects.toBe("The transfer was cancelled.");
    expect(invoke).toHaveBeenLastCalledWith("update_shared_transfer", expect.objectContaining({ status: "cancelled" }));
    expect(stop).toHaveBeenCalledOnce();
  });
  it("shares text through the same cancellable operation", async () => {
    await sendShared({ kind: "url", value: "https://example.org" }, { id: "mac", name: "Mac" });
    expect(invoke).toHaveBeenCalledWith("send_share_text", expect.objectContaining({ operationId: expect.any(String), kind: "url" }));
  });
});
