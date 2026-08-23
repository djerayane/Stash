import * as Y from "yjs";

export interface CollaborationSnapshot {
  noteId: string;
  sequence: number;
  update: Uint8Array;
  updatedAt: string;
  updatedByMemberId: string;
}

export interface NoteCollaborationRepository {
  loadNoteCollaboration(memberId: string, noteId: string): Promise<CollaborationSnapshot | undefined>;
  appendNoteCollaboration(memberId: string, noteId: string, update: Uint8Array): Promise<CollaborationSnapshot | undefined>;
}

export class InvalidCollaborationUpdate extends Error {}

export class NoteCollaborationService {
  constructor(private readonly repository: NoteCollaborationRepository) {}

  load(memberId: string, noteId: string) {
    return this.repository.loadNoteCollaboration(memberId, noteId);
  }

  async apply(memberId: string, noteId: string, update: Uint8Array) {
    if (update.byteLength === 0 || update.byteLength > 1_048_576) throw new InvalidCollaborationUpdate();
    try {
      const document = new Y.Doc();
      Y.applyUpdate(document, update);
      document.destroy();
    } catch {
      throw new InvalidCollaborationUpdate();
    }
    return this.repository.appendNoteCollaboration(memberId, noteId, update);
  }
}
