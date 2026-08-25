export function inspectIosSigningCapability(response, now = new Date()) {
  const app = response?.data?.app?.byId;
  if (!app || app.fullName !== "@djerayane/stash-capture") return { ready: false };
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
