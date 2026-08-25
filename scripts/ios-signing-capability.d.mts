export interface IosSigningCapability {
  ready: boolean;
  appleTeamId?: string;
}

export function inspectIosSigningCapability(response: unknown, now?: Date): IosSigningCapability;
