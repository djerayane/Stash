import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseMobileReleaseTag } from "../scripts/mobile-release-version.mjs";
import { inspectIosSigningCapability } from "../scripts/ios-signing-capability.mjs";
import { hashNativeTree } from "../scripts/hash-mobile-native-tree.mjs";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("mobile release contract", () => {
  it("pins the public Expo identity and explicit EAS artifact profiles", async () => {
    const app = JSON.parse(await read("apps/mobile/app.json"));
    const eas = JSON.parse(await read("apps/mobile/eas.json"));
    assert.equal(app.expo.owner, "djerayane");
    assert.equal(app.expo.slug, "stash-capture");
    assert.equal(app.expo.ios.bundleIdentifier, "app.stash.capture");
    assert.equal(app.expo.android.package, "app.stash.capture");
    const fixtureId = "123e4567-e89b-42d3-a456-426614174000";
    process.env.EAS_PROJECT_ID = fixtureId;
    const require = createRequire(import.meta.url);
    const config = require("../apps/mobile/app.config.cjs")();
    delete process.env.EAS_PROJECT_ID;
    assert.equal(config.extra.eas.projectId, fixtureId);
    assert.equal(config.ios.appleTeamId, undefined);
    assert.equal(eas.cli.appVersionSource, "remote");
    assert.deepEqual(eas.build.preview, {
      distribution: "internal", autoIncrement: true, android: { buildType: "apk" }
    });
    assert.equal(eas.build.production.autoIncrement, true);
    assert.equal(eas.build.production.distribution, "store");
    assert.equal(eas.build.production.android.buildType, "app-bundle");
    assert.deepEqual(eas.build.production.ios, {});
  });

  it("keeps PR validation secret-free and mobile publishers behind the complete gate", async () => {
    const pr = await read(".github/workflows/compose-quick-start.yml");
    const quality = await read(".github/workflows/release-quality.yml");
    const release = await read(".github/workflows/release.yml");
    assert.doesNotMatch(pr, /EXPO_TOKEN|secrets:/);
    assert.match(quality, /mobile-native-generation:/);
    assert.match(quality, /expo prebuild --clean --no-install/);
    assert.match(quality, /EAS_PROJECT_ID: \$\{\{ vars\.EAS_PROJECT_ID \}\}/);
    assert.doesNotMatch(`${quality}\n${release}`, /^    env:\n      EXPO_TOKEN:/m);
    for (const job of ["publish-android-preview", "publish-android-store", "publish-ios"]) {
      const section = release.split(`  ${job}:`)[1]?.split(/^  [a-z][\w-]+:/m)[0] ?? "";
      assert.match(section, /needs: release-quality/);
      assert.match(section, /environment: mobile-release/);
      assert.match(section, /EXPO_TOKEN: \$\{\{ secrets\.EXPO_TOKEN \}\}/);
      const jobPrefix = section.split(/\n    steps:/)[0] ?? "";
      assert.doesNotMatch(jobPrefix, /EXPO_TOKEN/);
    }
  });

  it("makes prerelease and unavailable-signing behavior explicit without false artifact claims", async () => {
    const release = `${await read(".github/workflows/release-quality.yml")}\n${await read(".github/workflows/release.yml")}`;
    assert.match(release, /Android store prerelease skipped: Play Store version requires a stable semantic version/);
    assert.match(release, /iOS prerelease skipped: App Store version requires a stable semantic version/);
    assert.match(release, /Mobile release unavailable: configure the EXPO_TOKEN GitHub Actions secret/);
    assert.match(release, /Android release unavailable: configure the EAS Android keystore for app\.stash\.capture/);
    assert.match(release, /iOS release unavailable: configure the Apple distribution certificate and provisioning profile for app\.stash\.capture/);
    assert.match(release, /Verify the allocated Android versionCode/);
    assert.match(release, /Verify the allocated iOS buildNumber/);
    assert.match(release, /probe-ios-signing\.mjs/);
    assert.doesNotMatch(release, /IOS_SIGNING_CONFIGURED/);
  });

  it("documents direct HTTPS pairing and no hosted relay", async () => {
    const docs = `${await read("README.md")}\n${await read("apps/mobile/README.md")}`;
    assert.match(docs, /HTTPS Instance/);
    assert.match(docs, /no (?:Stash-hosted )?relay/i);
    assert.match(docs, /APK/);
    assert.match(docs, /AAB/);
    assert.match(docs, /IPA/);
  });

  it("maps stable and prerelease tags without leaking prerelease identifiers into store versions", () => {
    assert.deepEqual(parseMobileReleaseTag("v2.3.4"), { version: "2.3.4", prerelease: "", stable: "true" });
    assert.deepEqual(parseMobileReleaseTag("v2.3.4-rc.2"), { version: "2.3.4-rc.2", prerelease: "rc.2", stable: "false" });
    assert.throws(() => parseMobileReleaseTag("v2.3.4+rebuilt"), /canonical semantic-version tag/);
    assert.throws(() => parseMobileReleaseTag("v2.3.4-rc.02"), /canonical semantic-version tag/);
  });

  it("requires live App Store certificate and provisioning-profile capability", () => {
    const base = { data: { app: { byId: { id: "project", fullName: "@djerayane/stash-capture", iosAppCredentials: [{
      appleTeam: { appleTeamIdentifier: "ABCDE12345" }, appleAppIdentifier: { bundleIdentifier: "app.stash.capture" },
      iosAppBuildCredentialsList: [{ iosDistributionType: "APP_STORE", distributionCertificate: { id: "cert", validityNotAfter: "2030-01-01T00:00:00.000Z" }, provisioningProfile: { id: "profile", expiration: "2030-01-01T00:00:00.000Z" } }]
    }] } } } };
    assert.deepEqual(inspectIosSigningCapability(base, new Date("2029-01-01T00:00:00.000Z")), { ready: true, appleTeamId: "ABCDE12345" });
    const missing = structuredClone(base); missing.data.app.byId.iosAppCredentials[0]!.iosAppBuildCredentialsList[0]!.provisioningProfile = null as any;
    assert.deepEqual(inspectIosSigningCapability(missing, new Date("2029-01-01T00:00:00.000Z")), { ready: false });
  });

  it("compares normalized content across the complete generated native tree", async () => {
    const parent = await mkdtemp(join(tmpdir(), "stash-native-hash-"));
    const first = join(parent, "first"); const second = join(parent, "second");
    await mkdir(join(first, "ios"), { recursive: true }); await mkdir(join(second, "ios"), { recursive: true });
    await writeFile(join(first, "ios", "project.pbxproj"), "AAAABBBBCCCCDDDDEEEEFFFF link AAAABBBBCCCCDDDDEEEEFFFF\nvalue=one\n");
    await writeFile(join(second, "ios", "project.pbxproj"), "111122223333444455556666 link 111122223333444455556666\nvalue=one\n");
    assert.equal(await hashNativeTree(first), await hashNativeTree(second));
    await writeFile(join(second, "ios", "project.pbxproj"), "111122223333444455556666 link 111122223333444455556666\nvalue=two\n");
    assert.notEqual(await hashNativeTree(first), await hashNativeTree(second));
  });
});
