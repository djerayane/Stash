import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function json(path: string) {
  return JSON.parse(await readFile(new URL(path, root), "utf8")) as Record<string, unknown>;
}

test("the approved clients and focused shared packages form a pnpm workspace", async () => {
  const workspace = await readFile(new URL("pnpm-workspace.yaml", root), "utf8");
  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);

  const rootPackage = await json("package.json");
  assert.match(String(rootPackage.packageManager), /^pnpm@/);
  assert.deepEqual(Object.keys(rootPackage.scripts as object).filter((name) => ["build", "check", "test"].includes(name)).sort(), ["build", "check", "test"]);
  assert.match(String((rootPackage.scripts as Record<string, string>).pretest), /@stash\/sync.*build/, "tests must build their generated sync runtime from a clean checkout");

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

  for (const name of ["domain-types", "api-client", "validation", "sync", "tokens"]) {
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
