import { access, readFile } from "node:fs/promises";

const tokens = await readFile(new URL("../src/tokens.css", import.meta.url), "utf8");
for (const name of [
  "--stash-color-canvas", "--stash-color-surface", "--stash-color-ink", "--stash-color-accent",
  "--stash-color-success", "--stash-border-subtle", "--stash-color-focus", "--stash-control-height",
  "--stash-radius-control", "--stash-duration-fast", "--stash-ease-standard", "--stash-type-caption",
  "--stash-type-body", "--stash-type-title", "--stash-elevation-surface",
]) {
  if (!tokens.includes(`${name}:`)) throw new Error(`Missing required design token ${name}`);
}
if (!tokens.includes("font-family: \"Stash Editorial\"") || !tokens.includes("url(\"./fonts/stix-two-text.ttf\")"))
  throw new Error("The display face must be a packaged local Stash Editorial font");
const sans = /--stash-font-sans:\s*([^;]+);/.exec(tokens)?.[1];
const display = /--stash-font-display:\s*([^;]+);/.exec(tokens)?.[1];
if (!sans || !display || sans === display || !display.includes("Stash Editorial"))
  throw new Error("The display font token must be distinct from the interface sans stack");
await access(new URL("../src/fonts/stix-two-text.ttf", import.meta.url));
await access(new URL("../src/fonts/OFL.txt", import.meta.url));
