import sharp from "sharp";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../public/codex-remote.svg", import.meta.url));

for (const size of [192, 512]) {
  await sharp(source)
    .resize(size, size)
    .png()
    .toFile(fileURLToPath(new URL(`../public/codex-remote-${size}.png`, import.meta.url)));
}

await sharp(source)
  .resize(32, 32)
  .png()
  .toFile(fileURLToPath(new URL("../public/opencodex-link-tray.png", import.meta.url)));
