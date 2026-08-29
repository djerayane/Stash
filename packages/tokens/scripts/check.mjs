import { access, readFile, readdir } from "node:fs/promises";

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

const webStyles = new URL("../../../apps/web/src/", import.meta.url);
const editorialDisplayUses = new Map([
  ["identity-access/setup-page.module.css", [".introduction h1", ".form h2"]],
  ["knowledge-authoring/note-tree.module.css", [".starterTutorial h2"]],
  ["note-editor.module.css", [".title"]],
]);
for (const path of (await readdir(webStyles, { recursive: true })).filter((entry) => entry.endsWith(".css"))) {
  const source = await readFile(new URL(path, webStyles), "utf8");
  const expected = editorialDisplayUses.get(path) ?? [];
  const uses = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) => match[2]?.includes("--stash-font-display")
    ? match[1].split(",").map((selector) => selector.trim()) : []);
  if (uses.length !== expected.length || expected.some((selector) => !uses.includes(selector))
    || uses.some((selector) => !expected.includes(selector))) {
    throw new Error(`Display face is restricted to editorial surfaces; audit ${path} (${uses.join(", ") || "no uses"})`);
  }
}
