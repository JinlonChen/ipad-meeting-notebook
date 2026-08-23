import Dexie, { type EntityTable } from "dexie";
import type { Folder, Meeting } from "@meeting/contracts";

export type OutboxKind =
  | "folder.create"
  | "folder.rename"
  | "folder.remove"
  | "meeting.create"
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

export class MeetingCatalogDatabase extends Dexie {
  declare meetings: EntityTable<Meeting, "id">;
  declare folders: EntityTable<Folder, "id">;
  declare outbox: EntityTable<OutboxOperation, "sequence">;
  declare settings: EntityTable<Setting, "key">;

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
  }
}
