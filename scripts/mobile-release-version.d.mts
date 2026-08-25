export interface MobileReleaseVersion {
  version: string;
  prerelease: string;
  stable: "true" | "false";
}

export function parseMobileReleaseTag(tag: string): MobileReleaseVersion;
