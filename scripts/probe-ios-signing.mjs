import { writeFile } from "node:fs/promises";
import { probeIosSigningCapability } from "./ios-signing-capability.mjs";

const projectId = process.env.EAS_PROJECT_ID ?? "";
const token = process.env.EXPO_TOKEN ?? "";
const capability = await probeIosSigningCapability({ projectId, token });

const output = [
  `ios-signing-configured=${capability.ready}`,
  `apple-team-id=${capability.appleTeamId ?? ""}`
].join("\n") + "\n";
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, output, { flag: "a" });
else process.stdout.write(output);
