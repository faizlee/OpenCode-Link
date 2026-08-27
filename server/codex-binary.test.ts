import { describe, expect, it } from "vitest";
import { queueHelpSupportsThread } from "./codex-binary.js";

describe("queueHelpSupportsThread", () => {
  it("accepts the Codex queue command that supports an explicit thread", () => {
    expect(queueHelpSupportsThread(`
Queue a message for an existing session

Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>
`)).toBe(true);
  });

  it("rejects an older Codex build that treats queue as a prompt", () => {
    expect(queueHelpSupportsThread("Usage: codex [OPTIONS] [PROMPT]"))
      .toBe(false);
  });
});
