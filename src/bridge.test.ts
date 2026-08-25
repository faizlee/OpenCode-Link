import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestId } from "./bridge";

describe("createRequestId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses randomUUID when the browser provides it", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "native-id" });
    expect(createRequestId()).toBe("native-id");
  });

  it("creates unique request ids when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(createRequestId()).not.toBe(createRequestId());
  });
});
