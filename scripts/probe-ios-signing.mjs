import { writeFile } from "node:fs/promises";
import { inspectIosSigningCapability } from "./ios-signing-capability.mjs";

const projectId = process.env.EAS_PROJECT_ID ?? "";
const token = process.env.EXPO_TOKEN ?? "";
const query = `query IosSigningCapability($appId: String!) {
  app { byId(appId: $appId) { id fullName iosAppCredentials {
    appleTeam { appleTeamIdentifier }
    appleAppIdentifier { bundleIdentifier }
    iosAppBuildCredentialsList(filter: { iosDistributionType: APP_STORE }) {
      iosDistributionType
      distributionCertificate { id validityNotAfter }
      provisioningProfile { id expiration }
    }
  } } }
}`;

let capability = { ready: false };
try {
  const response = await fetch("https://api.expo.dev/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { appId: projectId } })
  });
  if (!response.ok) throw new Error(`Expo API returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error("Expo API rejected the iOS signing-capability query");
  capability = inspectIosSigningCapability(body);
} catch (error) {
  process.stderr.write(`iOS signing capability probe unavailable: ${error instanceof Error ? error.message : "unknown error"}\n`);
}

const output = [
  `ios-signing-configured=${capability.ready}`,
  `apple-team-id=${capability.appleTeamId ?? ""}`
].join("\n") + "\n";
if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, output, { flag: "a" });
else process.stdout.write(output);
