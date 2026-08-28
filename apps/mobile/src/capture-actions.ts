import type { IncomingShareDelivery } from "@stash/domain-types";
import { mobileStatus, type MobileStatusPresentation } from "./mobile-status-presentation";

interface IncomingShareStore {
  listIncomingShares(): Promise<Array<Pick<IncomingShareDelivery, "id" | "status">>>;
  removeIncomingShare(id: string): Promise<void>;
}

export async function discardQuarantinedIncomingShares(store: IncomingShareStore): Promise<MobileStatusPresentation> {
  for (const item of await store.listIncomingShares()) {
    if (item.status === "quarantined") await store.removeIncomingShare(item.id);
  }
  return mobileStatus("saved", "Blocked shared items discarded.");
}
