import { describe, expect, it } from "vitest";
import { parseQueuedMessageId } from "./queue-message.js";

describe("parseQueuedMessageId", () => {
  it("reads the queue item id returned by Codex", () => {
    expect(parseQueuedMessageId("Queued message 01a03a93-ddf6 for thread thread-1.\n"))
      .toBe("01a03a93-ddf6");
  });

  it("returns null when an older Codex build omits the id", () => {
    expect(parseQueuedMessageId("Message queued.\n")).toBeNull();
  });
});
