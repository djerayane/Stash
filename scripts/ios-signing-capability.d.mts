export interface IosSigningCapability {
  ready: boolean;
  appleTeamId?: string;
}

export function inspectIosSigningCapability(response: unknown, now?: Date): IosSigningCapability;
export const iosSigningCapabilityQuery: string;
export function probeIosSigningCapability(options: {
  projectId: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<IosSigningCapability>;
