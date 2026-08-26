import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { probeIosSigningCapability, resolveEasProjectId } from "./ios-signing-capability.mjs";

const require = createRequire(import.meta.url);
const committedProjectId = require("../apps/mobile/app.json").expo.extra.eas.projectId;
const projectId = resolveEasProjectId(process.env.EAS_PROJECT_ID, committedProjectId);
const token = process.env.EXPO_TOKEN ?? "";
const capability = await probeIosSigningCapability({ projectId, token });

const output = [
  `ios-signing-configured=${capability.ready}`,
  `apple-team-id=${capability.appleTeamId ?? ""}`
].join("\n") + "\n";
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, output, { flag: "a" });
else process.stdout.write(output);
