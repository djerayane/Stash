export type MobileStatusVariant = "saved" | "waiting" | "synchronized" | "attention" | "error";

export interface MobileStatusPresentation {
  variant: MobileStatusVariant;
  message: string;
}

export function mobileStatus(variant: MobileStatusVariant, message: string): MobileStatusPresentation {
  return { variant, message };
}
