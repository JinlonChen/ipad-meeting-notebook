import {
  CreateFolderInputSchema,
  CreateMeetingInputSchema,
  FolderSchema,
  MeetingSchema,
  type Folder,
  type Meeting,
} from "@meeting/contracts";
import { z } from "zod";

import { type DeviceAccess, MeetingCatalogDatabase, type OutboxKind, type OutboxOperation } from "./local-db.js";

const MeetingIdSchema = CreateMeetingInputSchema.shape.id;
const MeetingTitleSchema = z.string().trim().min(1).max(120);
const FolderNameSchema = z.string().trim().min(1).max(80);
const IsoTimestampSchema = z.iso.datetime();
const DeviceAccessSchema = z.object({ authorizedAt: IsoTimestampSchema, expiresAt: IsoTimestampSchema }).strict();
const RestoreStatusSchema = z.enum(["draft", "recording", "recoverable", "uploading", "processing", "ready", "failed"]);

function restoreSettingKey(meetingId: string): string {
  return `meetingRestore:${meetingId}`;
}

export class MeetingNotFoundError extends Error {
  constructor(id: string) {
    super(`Meeting not found: ${id}`);
    this.name = "MeetingNotFoundError";
  }
}

export class FolderNotFoundError extends Error {
  constructor(id: string) {
    super(`Folder not found: ${id}`);
    this.name = "FolderNotFoundError";
  }
}

function timestamp(value: string): string {
  return new Date(IsoTimestampSchema.parse(value)).toISOString();
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

function operation(kind: OutboxKind, entityId: string, payload: unknown, createdAt: string): OutboxOperation {
  return { id: uuid(), entityId, kind, payload, createdAt, attempts: 0, lastError: null };
}

export type MeetingListOptions = {
  search?: string;
  includeTrashed?: boolean;
  folderId?: string | null;
};

export type MeetingCatalogRepositoryOptions = {
  beforeOutboxWrite?: (operation: OutboxOperation) => undefined;
};

export class MeetingCatalogRepository {
  private readonly db: MeetingCatalogDatabase;
  private readonly beforeOutboxWrite: NonNullable<MeetingCatalogRepositoryOptions["beforeOutboxWrite"]>;

  constructor(name?: string, options: MeetingCatalogRepositoryOptions = {}) {
    this.db = new MeetingCatalogDatabase(name);
    this.beforeOutboxWrite = options.beforeOutboxWrite ?? (() => undefined);
  }

  private enqueueOutbox(item: OutboxOperation): Promise<number | undefined> {
    this.beforeOutboxWrite(item);
    return this.db.outbox.add(item);
  }

  async deleteDatabase(): Promise<void> {
    this.db.close();
    await this.db.delete();
  }

  async create(title: string, folderId: string | null, now: string): Promise<Meeting> {
    const createdAt = timestamp(now);
    const value = CreateMeetingInputSchema.parse({ id: uuid(), title, folderId, clientCreatedAt: createdAt });
    return this.db.transaction("rw", this.db.meetings, this.db.folders, this.db.outbox, async () => {
      if (value.folderId && !(await this.db.folders.get(value.folderId))) throw new FolderNotFoundError(value.folderId);
      const meeting = MeetingSchema.parse({
        id: value.id,
        title: value.title,
        folderId: value.folderId,
        status: "draft",
        startedAt: null,
        endedAt: null,
        createdAt,
        updatedAt: createdAt,
        trashedAt: null,
        syncVersion: 0,
      });
      await this.db.meetings.add(meeting);
      await this.enqueueOutbox(operation("meeting.create", meeting.id, value, createdAt));
      return meeting;
    });
  }

  async get(id: string): Promise<Meeting | null> {
    return (await this.db.meetings.get(MeetingIdSchema.parse(id))) ?? null;
  }

  async list(options: MeetingListOptions = {}): Promise<Meeting[]> {
    const search = (options.search ?? "").trim().toLowerCase();
    const includeTrashed = options.includeTrashed ?? false;
    const meetings = await this.db.meetings.orderBy("updatedAt").reverse().toArray();
    return meetings.filter((meeting) =>
      (includeTrashed || meeting.status !== "trashed") &&
      (options.folderId === undefined || meeting.folderId === options.folderId) &&
      (!search || meeting.title.toLowerCase().includes(search)),
    );
  }

  async pendingOperations(): Promise<OutboxOperation[]> {
    return this.db.outbox.orderBy("sequence").toArray();
  }

  async createFolder(name: string, now: string): Promise<Folder> {
    const createdAt = timestamp(now);
    const value = CreateFolderInputSchema.parse({ id: uuid(), name, clientCreatedAt: createdAt });
    return this.db.transaction("rw", this.db.folders, this.db.outbox, async () => {
      const folder = FolderSchema.parse({ ...value, createdAt, updatedAt: createdAt, syncVersion: 0 });
      await this.db.folders.add(folder);
      await this.enqueueOutbox(operation("folder.create", folder.id, value, createdAt));
      return folder;
    });
  }

  async listFolders(): Promise<Folder[]> {
    return this.db.folders.orderBy("name").toArray();
  }

  async rename(id: string, title: string, now: string): Promise<Meeting> {
    const meetingId = MeetingIdSchema.parse(id);
    const normalizedTitle = MeetingTitleSchema.parse(title);
    const updatedAt = timestamp(now);
    return this.db.transaction("rw", this.db.meetings, this.db.outbox, async () => {
      const current = await this.db.meetings.get(meetingId);
      if (!current) throw new MeetingNotFoundError(meetingId);
      const meeting = MeetingSchema.parse({ ...current, title: normalizedTitle, updatedAt, syncVersion: current.syncVersion + 1 });
      await this.db.meetings.put(meeting);
      await this.enqueueOutbox(operation("meeting.rename", meetingId, { title: normalizedTitle, updatedAt }, updatedAt));
      return meeting;
    });
  }

  async trash(id: string, now: string): Promise<Meeting> {
    return this.setTrashed(id, now, true);
  }

  async restore(id: string, now: string): Promise<Meeting> {
    return this.setTrashed(id, now, false);
  }

  private async setTrashed(id: string, now: string, trashed: boolean): Promise<Meeting> {
    const meetingId = MeetingIdSchema.parse(id);
    const updatedAt = timestamp(now);
    return this.db.transaction("rw", this.db.meetings, this.db.outbox, this.db.settings, async () => {
      const current = await this.db.meetings.get(meetingId);
      if (!current) throw new MeetingNotFoundError(meetingId);
      if ((current.status === "trashed") === trashed) return current;
      const settingKey = restoreSettingKey(meetingId);
      const prior = RestoreStatusSchema.safeParse((await this.db.settings.get(settingKey))?.value);
      const meeting = MeetingSchema.parse({
        ...current,
        status: trashed ? "trashed" : (prior.success ? prior.data : "draft"),
        trashedAt: trashed ? updatedAt : null,
        updatedAt,
        syncVersion: current.syncVersion + 1,
      });
      if (trashed) await this.db.settings.put({ key: settingKey, value: current.status });
      else await this.db.settings.delete(settingKey);
      await this.db.meetings.put(meeting);
      await this.enqueueOutbox(operation(trashed ? "meeting.trash" : "meeting.restore", meetingId, { updatedAt }, updatedAt));
      return meeting;
    });
  }

  async renameFolder(id: string, name: string, now: string): Promise<Folder> {
    const folderId = MeetingIdSchema.parse(id);
    const normalizedName = FolderNameSchema.parse(name);
    const updatedAt = timestamp(now);
    return this.db.transaction("rw", this.db.folders, this.db.outbox, async () => {
      const current = await this.db.folders.get(folderId);
      if (!current) throw new FolderNotFoundError(folderId);
      const folder = FolderSchema.parse({ ...current, name: normalizedName, updatedAt, syncVersion: current.syncVersion + 1 });
      await this.db.folders.put(folder);
      await this.enqueueOutbox(operation("folder.rename", folderId, { name: normalizedName, updatedAt }, updatedAt));
      return folder;
    });
  }

  async removeFolder(id: string, now: string): Promise<void> {
    const folderId = MeetingIdSchema.parse(id);
    const updatedAt = timestamp(now);
    await this.db.transaction("rw", this.db.meetings, this.db.folders, this.db.outbox, async () => {
      if (!(await this.db.folders.get(folderId))) throw new FolderNotFoundError(folderId);
      const meetings = await this.db.meetings.where("folderId").equals(folderId).toArray();
      await Promise.all(meetings.map((meeting) => this.db.meetings.put(MeetingSchema.parse({
        ...meeting, folderId: null, updatedAt, syncVersion: meeting.syncVersion + 1,
      }))));
      await this.db.folders.delete(folderId);
      await this.enqueueOutbox(operation("folder.remove", folderId, { updatedAt }, updatedAt));
    });
  }

  async authorizeDevice(sessionExpiresAt: string, now: string): Promise<DeviceAccess> {
    const access = DeviceAccessSchema.parse({ authorizedAt: timestamp(now), expiresAt: timestamp(sessionExpiresAt) });
    await this.db.settings.put({ key: "deviceAccess", value: access });
    return access;
  }

  async hasDeviceAccess(now: string): Promise<boolean> {
    const setting = await this.db.settings.get("deviceAccess");
    const access = DeviceAccessSchema.safeParse(setting?.value);
    return access.success && timestamp(now) < timestamp(access.data.expiresAt);
  }

  async clearDeviceAccess(expected?: DeviceAccess): Promise<void> {
    await this.db.transaction("rw", this.db.settings, async () => {
      const current = DeviceAccessSchema.safeParse((await this.db.settings.get("deviceAccess"))?.value);
      if (!expected || (current.success && current.data.authorizedAt === expected.authorizedAt && current.data.expiresAt === expected.expiresAt)) {
        await this.db.settings.delete("deviceAccess");
      }
    });
  }

  async syncApplySuccessfulOperation(operationToApply: OutboxOperation, response: { meeting?: unknown; folder?: unknown }): Promise<void> {
    const sequence = z.number().int().nonnegative().parse(operationToApply.sequence);
    const expectsMeeting = operationToApply.kind.startsWith("meeting.");
    const expectsFolder = operationToApply.kind.startsWith("folder.") && operationToApply.kind !== "folder.remove";
    const receivedMeeting = response.meeting === undefined ? undefined : MeetingSchema.parse(response.meeting);
    const receivedFolder = response.folder === undefined ? undefined : FolderSchema.parse(response.folder);

    if (expectsMeeting && (!receivedMeeting || receivedFolder || receivedMeeting.id !== operationToApply.entityId)) {
      throw new Error("Invalid meeting sync response");
    }
    if (expectsFolder && (!receivedFolder || receivedMeeting || receivedFolder.id !== operationToApply.entityId)) {
      throw new Error("Invalid folder sync response");
    }
    if (!expectsMeeting && !expectsFolder && (receivedMeeting || receivedFolder)) {
      throw new Error("Unexpected sync response entity");
    }

    await this.db.transaction("rw", this.db.meetings, this.db.folders, this.db.outbox, async () => {
      const pending = await this.db.outbox.toArray();
      const hasLaterEntityMutation = pending.some((item) => item.entityId === operationToApply.entityId && item.sequence !== undefined && item.sequence > sequence);
      const pendingFolderRemovals = new Set(pending
        .filter((item) => item.kind === "folder.remove" && item.sequence !== sequence)
        .map((item) => item.entityId));

      if (operationToApply.kind === "folder.remove") {
        const meetings = await this.db.meetings.where("folderId").equals(operationToApply.entityId).toArray();
        await Promise.all(meetings.map((meeting) => this.db.meetings.put(MeetingSchema.parse({ ...meeting, folderId: null }))));
        await this.db.folders.delete(operationToApply.entityId);
      } else if (!hasLaterEntityMutation) {
        if (receivedMeeting) {
          await this.db.meetings.put(MeetingSchema.parse({
            ...receivedMeeting,
            folderId: receivedMeeting.folderId && pendingFolderRemovals.has(receivedMeeting.folderId) ? null : receivedMeeting.folderId,
          }));
        }
        if (receivedFolder && !pendingFolderRemovals.has(receivedFolder.id)) await this.db.folders.put(receivedFolder);
      }
      await this.db.outbox.delete(sequence);
    });
  }

  async syncRecordFailure(operationToUpdate: OutboxOperation, error: "SYNC_FAILED" | "AUTH_REQUIRED" | "CONFLICT"): Promise<void> {
    const sequence = z.number().int().nonnegative().parse(operationToUpdate.sequence);
    await this.db.outbox.update(sequence, {
      lastError: error,
      ...(error === "SYNC_FAILED" ? { attempts: operationToUpdate.attempts + 1 } : {}),
    });
  }

  async syncRefresh(foldersInput: unknown, meetingsInput: unknown): Promise<void> {
    const folders = z.array(FolderSchema).parse(foldersInput);
    const meetings = z.array(MeetingSchema).parse(meetingsInput);
    await this.db.transaction("rw", this.db.meetings, this.db.folders, this.db.outbox, async () => {
      const operations = await this.db.outbox.toArray();
      const pendingEntityIds = new Set(operations.map((item) => item.entityId));
      const remoteFolderIds = new Set(folders.map((folder) => folder.id));
      const remoteMeetingIds = new Set(meetings.map((meeting) => meeting.id));

      for (const local of await this.db.folders.toArray()) {
        if (!pendingEntityIds.has(local.id) && !remoteFolderIds.has(local.id)) await this.db.folders.delete(local.id);
      }
      for (const folder of folders) {
        if (!pendingEntityIds.has(folder.id)) await this.db.folders.put(folder);
      }

      for (const local of await this.db.meetings.toArray()) {
        if (!pendingEntityIds.has(local.id) && !remoteMeetingIds.has(local.id)) await this.db.meetings.delete(local.id);
      }
      const availableFolderIds = new Set((await this.db.folders.toArray()).map((folder) => folder.id));
      for (const meeting of meetings) {
        if (!pendingEntityIds.has(meeting.id)) {
          await this.db.meetings.put(MeetingSchema.parse({
            ...meeting,
            folderId: meeting.folderId && availableFolderIds.has(meeting.folderId) ? meeting.folderId : null,
          }));
        }
      }

      for (const local of await this.db.meetings.toArray()) {
        if (local.folderId && !availableFolderIds.has(local.folderId)) {
          await this.db.meetings.put(MeetingSchema.parse({ ...local, folderId: null }));
          const create = operations.find((operation) => operation.entityId === local.id && operation.kind === "meeting.create");
          if (create?.sequence !== undefined) {
            const payload = CreateMeetingInputSchema.parse(create.payload);
            await this.db.outbox.update(create.sequence, {
              payload: CreateMeetingInputSchema.parse({ ...payload, folderId: null }),
            });
          }
        }
      }
    });
  }
}
