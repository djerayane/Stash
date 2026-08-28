import { readFile } from "node:fs/promises";

const tokens = await readFile(new URL("../src/tokens.css", import.meta.url), "utf8");
for (const name of [
  "--stash-color-canvas", "--stash-color-surface", "--stash-color-ink", "--stash-color-accent",
  "--stash-color-success", "--stash-border-subtle", "--stash-color-focus", "--stash-control-height",
  "--stash-radius-control", "--stash-duration-fast", "--stash-ease-standard", "--stash-type-caption",
  "--stash-type-body", "--stash-type-title", "--stash-elevation-surface",
]) {
  if (!tokens.includes(`${name}:`)) throw new Error(`Missing required design token ${name}`);
}
