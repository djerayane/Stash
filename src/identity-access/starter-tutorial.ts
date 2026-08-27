import type { StarterTutorialContribution } from "./instance-setup.js";

export interface StarterTutorialNote {
  id: string;
  title: string;
  content: string;
  parentId?: string;
}

export interface StarterTutorialLink {
  id: string;
  sourceNoteId: string;
  targetNoteId: string;
  label: string;
}

export interface StarterTutorial extends StarterTutorialContribution {
  workspaceId: string;
  notes: StarterTutorialNote[];
  links: StarterTutorialLink[];
}

export interface StarterTutorialRepository {
  readStarterTutorial(memberId: string, rootNoteId: string): Promise<StarterTutorial | undefined>;
  renameStarterCollection(memberId: string, rootNoteId: string, name: string): Promise<StarterTutorial | undefined>;
}

export class InvalidStarterTutorialInput extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class StarterTutorialService {
  constructor(private readonly repository: StarterTutorialRepository) {}

  read(memberId: string, rootNoteId: string) {
    if (!uuid.test(rootNoteId)) throw new InvalidStarterTutorialInput();
    return this.repository.readStarterTutorial(memberId, rootNoteId);
  }

  renameCollection(memberId: string, rootNoteId: string, value: unknown) {
    if (!uuid.test(rootNoteId) || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new InvalidStarterTutorialInput();
    }
    const input = value as Record<string, unknown>;
    if (Object.keys(input).length !== 1 || typeof input.name !== "string" || !input.name.trim()
      || input.name.trim().length > 120 || /[\r\n]/.test(input.name)) throw new InvalidStarterTutorialInput();
    return this.repository.renameStarterCollection(memberId, rootNoteId, input.name.trim());
  }
}
