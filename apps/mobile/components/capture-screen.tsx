import type { ReactNode } from "react";

import { CaptureComposer } from "@/components/capture-composer";
import { MobileStatusNotice } from "@/components/mobile-status-notice";
import { NativeActionButton } from "@/components/native-controls";
import { Screen } from "@/components/screen";
import type { MobileStatusPresentation } from "@/src/mobile-status-presentation";

export function CaptureScreenComposition({ status, destinations, recovery, content, checklist, onContentChange,
  onChecklistChange, media, structure, saveLabel, saveDisabled, onSave }: {
  status: MobileStatusPresentation;
  destinations: ReactNode;
  recovery?: ReactNode;
  content: string;
  checklist: boolean;
  onContentChange(value: string): void;
  onChecklistChange(value: boolean): void;
  media: ReactNode;
  structure: ReactNode;
  saveLabel: string;
  saveDisabled: boolean;
  onSave(): void;
}) {
  return <Screen bottomAction={<NativeActionButton label={saveLabel} disabled={saveDisabled} onPress={onSave} />}>
    <MobileStatusNotice variant={status.variant} message={status.message} />
    {destinations}
    {recovery}
    <CaptureComposer content={content} checklist={checklist} onContentChange={onContentChange}
      onChecklistChange={onChecklistChange} media={media} structure={structure} />
  </Screen>;
}
