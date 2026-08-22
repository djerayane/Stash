import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { parseIncomingCapture } from "../mobile/src/incoming-capture.js";

describe("native mobile capture entry points", () => {
  it("configures OS share targets on iOS and Android", async () => {
    const app = JSON.parse(await readFile(new URL("../mobile/app.json", import.meta.url), "utf8")) as {
      expo: { plugins: unknown[] };
    };
    const sharing = app.expo.plugins.find((plugin): plugin is [string, any] => Array.isArray(plugin) && plugin[0] === "expo-sharing");
    assert.equal(sharing?.[1].ios.enabled, true);
    assert.equal(sharing?.[1].android.enabled, true);
    assert.deepEqual(sharing?.[1].android.singleShareMimeTypes, ["text/*", "image/*", "audio/*", "application/*"]);
  });

  it("ships iOS and Android widget providers that invoke the validated capture boundary", async () => {
    const swift = await readFile(new URL("../mobile/targets/capture-widget/StashCaptureWidget.swift", import.meta.url), "utf8");
    const plugin = await readFile(new URL("../mobile/plugins/with-android-capture-widget.js", import.meta.url), "utf8");
    assert.match(swift, /AppIntentConfiguration/);
    assert.match(swift, /URLQueryItem\(name: "source", value: "widget"\)/);
    assert.match(plugin, /AppWidgetProvider/);
    const androidUrl = plugin.match(/stash:\/\/capture\?source=widget&content=[^\\"]+/)?.[0];
    assert.ok(androidUrl);
    assert.deepEqual(parseIncomingCapture(androidUrl),
      { kind: "capture", capture: { source: "widget", content: "New widget capture" } });
  });
});
