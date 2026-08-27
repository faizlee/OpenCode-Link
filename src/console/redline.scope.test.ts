import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Redline console style isolation", () => {
  it("scopes Redline tokens to the console root and keeps the phone theme dark", () => {
    const redline = readFileSync(join(srcRoot, "console/redline.css"), "utf8");
    const phone = readFileSync(join(srcRoot, "styles.css"), "utf8");

    expect(redline).toContain(".console-root");
    expect(redline).toContain("#fffcf8");
    expect(redline).toContain("#1b1b1b");
    expect(redline).toContain("#e7131a");
    expect(redline).toContain("#594d46");
    expect(redline).toContain("#efe3dc");
    expect(redline).toMatch(/Source Han Serif SC|Noto Serif SC|Songti SC/);
    expect(redline).not.toMatch(/\bTIME\b/);
    expect(redline).not.toMatch(/box-shadow:\s*(?!none)/);
    expect(phone).toContain("background: #101316");
    expect(phone).toContain("--accent: #58d69b");
    expect(phone).not.toContain("#fffcf8");
  });
});
