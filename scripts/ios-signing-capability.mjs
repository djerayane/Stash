export function inspectIosSigningCapability(response, now = new Date()) {
  if (!response || typeof response !== "object" || response.errors?.length) {
    throw new Error("Expo API rejected the iOS signing-capability query");
  }
  const app = response?.data?.app?.byId;
  if (!app || !Array.isArray(app.iosAppCredentials)) {
    throw new Error("Expo API returned a malformed iOS signing-capability response");
  }
  if (app.fullName !== "@imnibis/stash-capture") return { ready: false };
  const credentials = app.iosAppCredentials?.find(
    (entry) => entry?.appleAppIdentifier?.bundleIdentifier === "app.stash.capture"
  );
  const build = credentials?.iosAppBuildCredentialsList?.find(
    (entry) => entry?.iosDistributionType === "APP_STORE"
  );
  const certificateExpires = Date.parse(build?.distributionCertificate?.validityNotAfter ?? "");
  const profileExpires = Date.parse(build?.provisioningProfile?.expiration ?? "");
  const appleTeamId = credentials?.appleTeam?.appleTeamIdentifier;
  if (!build?.distributionCertificate?.id || !build?.provisioningProfile?.id ||
      !Number.isFinite(certificateExpires) || certificateExpires <= now.getTime() ||
      !Number.isFinite(profileExpires) || profileExpires <= now.getTime() ||
      !/^[A-Z0-9]{10}$/.test(appleTeamId ?? "")) return { ready: false };
  return { ready: true, appleTeamId };
}

export const iosSigningCapabilityQuery = `query IosSigningCapability($appId: String!) {
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

export async function probeIosSigningCapability({ projectId, token, fetchImpl = fetch }) {
  const response = await fetchImpl("https://api.expo.dev/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: iosSigningCapabilityQuery, variables: { appId: projectId } })
  });
  if (!response.ok) throw new Error(`Expo API returned HTTP ${response.status}`);
  let body;
  try { body = await response.json(); }
  catch { throw new Error("Expo API returned a malformed iOS signing-capability response"); }
  return inspectIosSigningCapability(body);
}
