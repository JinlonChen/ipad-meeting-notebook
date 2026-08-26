import Dexie, { type EntityTable } from "dexie";
import type { AudioChunkMetadata, Folder, InkStroke, Meeting, RecordingSession } from "@meeting/contracts";

export type OutboxKind =
  | "folder.create"
  | "folder.rename"
  | "folder.remove"
  | "meeting.create"
  | "meeting.note"
  | "meeting.rename"
  | "meeting.trash"
  | "meeting.restore";

export type OutboxOperation = {
  sequence?: number;
  id: string;
  entityId: string;
  kind: OutboxKind;
  payload: unknown;
  createdAt: string;
  attempts: number;
  lastError: string | null;
};

export type DeviceAccess = {
  userId: string;
  authorizedAt: string;
  expiresAt: string;
};

type Setting = { key: string; value: unknown };

export type LocalAudioChunk = AudioChunkMetadata & { blob: Blob };

export type LocalInkMutation = {
  strokeId: string;
  mutationId: string;
  stroke: InkStroke;
  createdAt: string;
};

export class MeetingCatalogDatabase extends Dexie {
  declare meetings: EntityTable<Meeting, "id">;
  declare folders: EntityTable<Folder, "id">;
  declare outbox: EntityTable<OutboxOperation, "sequence">;
  declare settings: EntityTable<Setting, "key">;
  declare recordingSessions: EntityTable<RecordingSession, "meetingId">;
  declare audioChunks: EntityTable<LocalAudioChunk, "id">;
  declare inkStrokes: EntityTable<InkStroke, "id">;
  declare inkOutbox: EntityTable<LocalInkMutation, "strokeId">;

  constructor(name = "meeting-catalog") {
    super(name);
    this.version(1).stores({
      meetings: "id,updatedAt,status,folderId,title",
      folders: "id,name,updatedAt",
      outbox: "++sequence,id,entityId,kind,createdAt",
      settings: "key",
    });
    this.version(2).stores({
      meetings: "id,updatedAt,status,folderId,title",
      folders: "id,name,updatedAt",
      outbox: "++sequence,id,entityId,kind,createdAt",
      settings: "key",
    }).upgrade((transaction) => transaction.table<OutboxOperation>("outbox").toCollection().modify((item) => {
      if (!item.id) item.id = globalThis.crypto.randomUUID();
    }));
    this.version(3).stores({
      meetings: "id,updatedAt,status,folderId,title",
      folders: "id,name,updatedAt",
      outbox: "++sequence,id,entityId,kind,createdAt",
      settings: "key",
    }).upgrade(async (transaction) => {
      await transaction.table<Meeting>("meetings").toCollection().modify((meeting) => {
        if (typeof meeting.note !== "string") meeting.note = "";
      });
    });
    this.version(4).stores({
      meetings: "id,updatedAt,status,folderId,title",
      folders: "id,name,updatedAt",
      outbox: "++sequence,id,entityId,kind,createdAt",
      settings: "key",
      recordingSessions: "meetingId,state,startedAt,expiresAt",
      audioChunks: "id,[meetingId+sequence],meetingId,uploadState,expiresAt",
    });
    this.version(5).stores({
      meetings: "id,updatedAt,status,folderId,title",
      folders: "id,name,updatedAt",
      outbox: "++sequence,id,entityId,kind,createdAt",
      settings: "key",
      recordingSessions: "meetingId,state,startedAt,expiresAt",
      audioChunks: "id,[meetingId+sequence],meetingId,uploadState,expiresAt",
      inkStrokes: "id,[meetingId+order],meetingId,deleted,version",
      inkOutbox: "strokeId,createdAt",
    });
  }
}
