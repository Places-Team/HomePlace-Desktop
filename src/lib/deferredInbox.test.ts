import { describe, expect, it } from "vitest";
import { DeferredInbox } from "./deferredInbox";

describe("native share inbox", () => {
  it("retains a fetched item when a transfer starts during the read", async () => {
    const inbox = new DeferredInbox<string>();
    let ready = true;
    const accepted: string[] = [];
    await inbox.drain(async () => { ready = false; return "file"; }, () => ready, item => accepted.push(item));
    expect(accepted).toEqual([]);
    ready = true;
    await inbox.drain(async () => null, () => ready, item => accepted.push(item));
    expect(accepted).toEqual(["file"]);
  });

  it("serializes overlapping notifications and consumes each item once", async () => {
    const inbox = new DeferredInbox<string>();
    let resolve!: (item: string | null) => void;
    let reads = 0;
    const accepted: string[] = [];
    const read = () => ++reads === 1 ? new Promise<string | null>(done => { resolve = done; }) : Promise.resolve(null);
    const first = inbox.drain(read, () => true, item => accepted.push(item));
    await inbox.drain(read, () => true, item => accepted.push(item));
    expect(reads).toBe(1);
    resolve("file");
    await first;
    expect(accepted).toEqual(["file"]);
  });

  it("does not read while busy and recovers after a read failure", async () => {
    const inbox = new DeferredInbox<string>();
    let reads = 0;
    const read = async () => { reads++; throw new Error("offline"); };
    await inbox.drain(read, () => false, () => {});
    expect(reads).toBe(0);
    await expect(inbox.drain(read, () => true, () => {})).rejects.toThrow("offline");
    await inbox.drain(async () => null, () => true, () => {});
  });

  it("keeps an item if accepting it fails", async () => {
    const inbox = new DeferredInbox<string>();
    await expect(inbox.drain(async () => "file", () => true, () => {
      throw new Error("not ready");
    })).rejects.toThrow("not ready");
    const accepted: string[] = [];
    await inbox.drain(async () => null, () => true, item => accepted.push(item));
    expect(accepted).toEqual(["file"]);
  });
});
