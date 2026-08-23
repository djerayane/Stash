import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import type { RichTextBlock, RichTextMark, RichTextSpan } from "@stash/sync";

const root = new URL("../", import.meta.url);

const compatibilityMark: RichTextMark = "bold";
const compatibilitySpan: RichTextSpan = { text: "Shared contract", marks: [compatibilityMark] };
const compatibilityBlock: RichTextBlock = { type: "paragraph", content: [compatibilitySpan] };

async function json(path: string) {
  return JSON.parse(await readFile(new URL(path, root), "utf8")) as Record<string, unknown>;
}

test("the approved clients and focused shared packages form a pnpm workspace", async () => {
  assert.equal(compatibilityBlock.content[0]?.text, "Shared contract");
  const workspace = await readFile(new URL("pnpm-workspace.yaml", root), "utf8");
  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);

  const rootPackage = await json("package.json");
  assert.match(String(rootPackage.packageManager), /^pnpm@/);
  assert.deepEqual(Object.keys(rootPackage.scripts as object).filter((name) => ["build", "check", "test"].includes(name)).sort(), ["build", "check", "test"]);
  assert.equal(
    (rootPackage.scripts as Record<string, string>).pretest,
    "pnpm run build:shared",
    "tests must build the sync runtime and its transitive workspace dependencies from a clean checkout",
  );
  const scripts = rootPackage.scripts as Record<string, string>;
  assert.equal(scripts["build:shared"], "pnpm --filter @stash/sync... --filter @stash/rich-text... build");
  for (const entryPoint of ["unit", "integration", "browser", "a11y"]) {
    assert.equal(
      scripts[`pretest:${entryPoint}`],
      "pnpm run build:shared",
      `the direct ${entryPoint} client test entry point must build shared runtime packages first`,
    );
  }

  const readme = await readFile(new URL("README.md", root), "utf8");
  assert.doesNotMatch(readme, /\bnpm (?:ci|install|run|test)\b|package-lock\.json/);

  const web = await json("apps/web/package.json");
  const webDependencies = web.dependencies as Record<string, string>;
  assert.match(webDependencies.react ?? "", /^\^19/);
  assert.equal(typeof webDependencies["react-router"], "string");
  assert.equal(typeof webDependencies["@tanstack/react-query"], "string");
  assert.equal(typeof (web.devDependencies as Record<string, string>).vite, "string");

  const mobile = await json("apps/mobile/package.json");
  const mobileDependencies = mobile.dependencies as Record<string, string>;
  assert.equal(typeof mobileDependencies.expo, "string");
  for (const name of ["api-client", "domain-types", "validation", "sync"]) {
    assert.equal(mobileDependencies[`@stash/${name}`], "workspace:*", `mobile must consume @stash/${name} through pnpm`);
  }

  for (const name of ["domain-types", "api-client", "validation", "sync", "rich-text", "tokens"]) {
    const manifest = await json(`packages/${name}/package.json`);
    assert.equal(typeof manifest.exports, "object", `${name} must publish an explicit API`);
    const dependencies = { ...(manifest.dependencies as Record<string, string> | undefined),
      ...(manifest.devDependencies as Record<string, string> | undefined) };
    assert.equal(dependencies.react, undefined, `${name} must remain independent of React`);
    assert.equal(dependencies["react-dom"], undefined, `${name} must remain independent of React DOM`);
  }

  await assert.rejects(access(new URL("packages/ui/package.json", root)));
  await assert.rejects(access(new URL("mobile/package.json", root)));
});
