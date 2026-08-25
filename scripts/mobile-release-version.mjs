export function parseMobileReleaseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag);
  if (!match) throw new Error("mobile release requires a canonical semantic-version tag without build metadata");
  if (match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error("mobile release requires a canonical semantic-version tag without build metadata");
  }
  const coreVersion = `${match[1]}.${match[2]}.${match[3]}`;
  return {
    version: match[4] ? `${coreVersion}-${match[4]}` : coreVersion,
    prerelease: match[4] ?? "",
    stable: String(!match[4])
  };
}
