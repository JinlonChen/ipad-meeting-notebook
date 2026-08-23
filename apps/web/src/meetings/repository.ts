import {
  CreateFolderInputSchema,
  CreateMeetingInputSchema,
  FolderSchema,
  MeetingSchema,
  type Folder,
  type Meeting,
} from "@meeting/contracts";
import Dexie from "dexie";
import { z } from "zod";

import { type DeviceAccess, MeetingCatalogDatabase, type OutboxKind, type OutboxOperation } from "./local-db.js";

const MeetingIdSchema = CreateMeetingInputSchema.shape.id;
const MeetingTitleSchema = z.string().trim().min(1).max(120);
const FolderNameSchema = z.string().trim().min(1).max(80);
const IsoTimestampSchema = z.iso.datetime();
const UserIdSchema = z.uuid().transform((value) => value.toLowerCase());
const DeviceAccessSchema = z.object({ userId: UserIdSchema, authorizedAt: IsoTimestampSchema, expiresAt: IsoTimestampSchema }).strict();
const RestoreStatusSchema = z.enum(["draft", "recording", "recoverable", "uploading", "processing", "ready", "failed"]);
const outboxSource = Symbol("outboxSource");

type SourcedOutboxOperation = OutboxOperation & {
  [outboxSource]?: MeetingCatalogDatabase;
};

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
  afterLegacyOwnerClaim?: () => undefined;
};

export type PendingConflict = {
  sequence: number;
  kind: OutboxKind;
  entityName: string;
};

export type PendingStatus = {
  count: number;
  conflict: PendingConflict | null;
};

export class MeetingCatalogRepository {
  private readonly baseName: string;
  private readonly bootstrapDb: MeetingCatalogDatabase;
  private db: MeetingCatalogDatabase;
  private activeUserId: string | null = null;
  private activationQueue: Promise<void> = Promise.resolve();
  private readonly userDatabases = new Map<string, MeetingCatalogDatabase>();
  private readonly beforeOutboxWrite: NonNullable<MeetingCatalogRepositoryOptions["beforeOutboxWrite"]>;
  private readonly afterLegacyOwnerClaim: NonNullable<MeetingCatalogRepositoryOptions["afterLegacyOwnerClaim"]>;

  constructor(name?: string, options: MeetingCatalogRepositoryOptions = {}) {
    this.baseName = name ?? "meeting-catalog";
    this.bootstrapDb = new MeetingCatalogDatabase(this.baseName);
    this.db = this.bootstrapDb;
    this.beforeOutboxWrite = options.beforeOutboxWrite ?? (() => undefined);
    this.afterLegacyOwnerClaim = options.afterLegacyOwnerClaim ?? (() => undefined);
  }

  private enqueueOutbox(db: MeetingCatalogDatabase, item: OutboxOperation): Promise<number | undefined> {
    this.beforeOutboxWrite(item);
    return db.outbox.add(item);
  }

  private operationSource(item: OutboxOperation): MeetingCatalogDatabase {
    const source = (item as SourcedOutboxOperation)[outboxSource];
    if (!source) throw new Error("OUTBOX_SOURCE_REQUIRED");
    return source;
  }

  async activateUser(userIdInput: string): Promise<void> {
    const userId = UserIdSchema.parse(userIdInput);
    const activation = this.activationQueue.then(async () => {
      let userDb = this.userDatabases.get(userId);
      if (!userDb) {
        userDb = new MeetingCatalogDatabase(`${this.baseName}--user--${userId}`);
        this.userDatabases.set(userId, userDb);
      }

      const owner = await this.bootstrapDb.transaction("rw", this.bootstrapDb.settings, async () => {
        const current = UserIdSchema.safeParse((await this.bootstrapDb.settings.get("catalogOwner"))?.value);
        if (current.success) return { userId: current.data, claimed: false };
        await this.bootstrapDb.settings.put({ key: "catalogOwner", value: userId });
        return { userId, claimed: true };
      });
      if (owner.userId === userId) {
        if (owner.claimed) this.afterLegacyOwnerClaim();
        const legacy = await this.bootstrapDb.transaction(
          "r",
          this.bootstrapDb.meetings,
          this.bootstrapDb.folders,
          this.bootstrapDb.outbox,
          this.bootstrapDb.settings,
          async () => ({
            meetings: await this.bootstrapDb.meetings.toArray(),
            folders: await this.bootstrapDb.folders.toArray(),
            outbox: await this.bootstrapDb.outbox.toArray(),
            settings: (await this.bootstrapDb.settings.toArray()).filter((item) => item.key !== "deviceAccess" && item.key !== "catalogOwner"),
          }),
        );
        await userDb.transaction("rw", userDb.meetings, userDb.folders, userDb.outbox, userDb.settings, async () => {
          await userDb!.meetings.bulkPut(legacy.meetings);
          await userDb!.folders.bulkPut(legacy.folders);
          await userDb!.outbox.bulkPut(legacy.outbox);
          await userDb!.settings.bulkPut(legacy.settings);
        });
        await this.bootstrapDb.transaction(
          "rw",
          this.bootstrapDb.meetings,
          this.bootstrapDb.folders,
          this.bootstrapDb.outbox,
          this.bootstrapDb.settings,
          async () => {
            await this.bootstrapDb.meetings.clear();
            await this.bootstrapDb.folders.clear();
            await this.bootstrapDb.outbox.clear();
            for (const setting of legacy.settings) await this.bootstrapDb.settings.delete(setting.key);
          },
        );
      }

      this.activeUserId = userId;
      this.db = userDb;
    });
    this.activationQueue = activation.catch(() => undefined);
    await activation;
  }

  currentUserId(): string | null {
    return this.activeUserId;
  }

  async deleteDatabase(): Promise<void> {
    await this.activationQueue;
    for (const database of [this.bootstrapDb, ...this.userDatabases.values()]) database.close();
    const userPrefix = `${this.baseName}--user--`;
    const databaseNames = (await Dexie.getDatabaseNames()).filter((name) =>
      name === this.baseName || (name.startsWith(userPrefix) && UserIdSchema.safeParse(name.slice(userPrefix.length)).success),
    );
    await Promise.all(databaseNames.map((name) => Dexie.delete(name)));
  }

  async create(title: string, folderId: string | null, now: string): Promise<Meeting> {
    const db = this.db;
    const createdAt = timestamp(now);
    const value = CreateMeetingInputSchema.parse({ id: uuid(), title, folderId, clientCreatedAt: createdAt });
    return db.transaction("rw", db.meetings, db.folders, db.outbox, async () => {
      if (value.folderId && !(await db.folders.get(value.folderId))) throw new FolderNotFoundError(value.folderId);
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
      await db.meetings.add(meeting);
      await this.enqueueOutbox(db, operation("meeting.create", meeting.id, value, createdAt));
      return meeting;
    });
  }

  async get(id: string): Promise<Meeting | null> {
    const db = this.db;
    return (await db.meetings.get(MeetingIdSchema.parse(id))) ?? null;
  }

  async list(options: MeetingListOptions = {}): Promise<Meeting[]> {
    const db = this.db;
    const search = (options.search ?? "").trim().toLowerCase();
    const includeTrashed = options.includeTrashed ?? false;
    const meetings = await db.meetings.orderBy("updatedAt").reverse().toArray();
    return meetings.filter((meeting) =>
      (includeTrashed || meeting.status !== "trashed") &&
      (options.folderId === undefined || meeting.folderId === options.folderId) &&
      (!search || meeting.title.toLowerCase().includes(search)),
    );
  }

  async pendingOperations(): Promise<OutboxOperation[]> {
    const db = this.db;
    const operations = await db.outbox.orderBy("sequence").toArray();
    for (const item of operations) {
      Object.defineProperty(item, outboxSource, { value: db, enumerable: false });
    }
    return operations;
  }

  async pendingStatus(): Promise<PendingStatus> {
    const db = this.db;
    return db.transaction("r", db.meetings, db.folders, db.outbox, async () => {
      const operations = await db.outbox.orderBy("sequence").toArray();
      const conflict = operations.find((item) => item.lastError === "CONFLICT" && item.sequence !== undefined);
      if (!conflict || conflict.sequence === undefined) return { count: operations.length, conflict: null };
      const meeting = conflict.kind.startsWith("meeting.") ? await db.meetings.get(conflict.entityId) : undefined;
      const folder = conflict.kind.startsWith("folder.") ? await db.folders.get(conflict.entityId) : undefined;
      return {
        count: operations.length,
        conflict: {
          sequence: conflict.sequence,
          kind: conflict.kind,
          entityName: meeting?.title ?? folder?.name ?? (conflict.kind.startsWith("meeting.") ? "该会议" : "该分类"),
        },
      };
    });
  }

  async resolveConflict(sequenceInput: number): Promise<void> {
    const db = this.db;
    const sequence = z.number().int().nonnegative().parse(sequenceInput);
    await db.transaction("rw", db.meetings, db.folders, db.outbox, db.settings, async () => {
      const conflict = await db.outbox.get(sequence);
      if (!conflict || conflict.lastError !== "CONFLICT") throw new Error("Conflict operation not found");
      const operations = await db.outbox.orderBy("sequence").toArray();
      const discardedSequences = operations
        .filter((item) => item.entityId === conflict.entityId && item.sequence !== undefined && item.sequence >= sequence)
        .map((item) => item.sequence!);

      if (conflict.kind === "meeting.create") {
        await db.meetings.delete(conflict.entityId);
        await db.settings.delete(restoreSettingKey(conflict.entityId));
      }

      if (conflict.kind === "folder.create") {
        await db.folders.delete(conflict.entityId);
        const meetings = await db.meetings.where("folderId").equals(conflict.entityId).toArray();
        for (const meeting of meetings) {
          await db.meetings.put(MeetingSchema.parse({ ...meeting, folderId: null }));
        }
        for (const item of operations) {
          if (item.kind !== "meeting.create" || item.sequence === undefined || discardedSequences.includes(item.sequence)) continue;
          const payload = CreateMeetingInputSchema.parse(item.payload);
          if (payload.folderId === conflict.entityId) {
            await db.outbox.update(item.sequence, {
              payload: CreateMeetingInputSchema.parse({ ...payload, folderId: null }),
            });
          }
        }
      }

      await db.outbox.bulkDelete(discardedSequences);
    });
  }

  async createFolder(name: string, now: string): Promise<Folder> {
    const db = this.db;
    const createdAt = timestamp(now);
    const value = CreateFolderInputSchema.parse({ id: uuid(), name, clientCreatedAt: createdAt });
    return db.transaction("rw", db.folders, db.outbox, async () => {
      const folder = FolderSchema.parse({ ...value, createdAt, updatedAt: createdAt, syncVersion: 0 });
      await db.folders.add(folder);
      await this.enqueueOutbox(db, operation("folder.create", folder.id, value, createdAt));
      return folder;
    });
  }

  async listFolders(): Promise<Folder[]> {
    const db = this.db;
    return db.folders.orderBy("name").toArray();
  }

  async rename(id: string, title: string, now: string): Promise<Meeting> {
    const db = this.db;
    const meetingId = MeetingIdSchema.parse(id);
    const normalizedTitle = MeetingTitleSchema.parse(title);
    const updatedAt = timestamp(now);
    return db.transaction("rw", db.meetings, db.outbox, async () => {
      const current = await db.meetings.get(meetingId);
      if (!current) throw new MeetingNotFoundError(meetingId);
      const meeting = MeetingSchema.parse({ ...current, title: normalizedTitle, updatedAt, syncVersion: current.syncVersion + 1 });
      await db.meetings.put(meeting);
      await this.enqueueOutbox(db, operation("meeting.rename", meetingId, { title: normalizedTitle, updatedAt, expectedSyncVersion: current.syncVersion }, updatedAt));
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
    const db = this.db;
    const meetingId = MeetingIdSchema.parse(id);
    const updatedAt = timestamp(now);
    return db.transaction("rw", db.meetings, db.outbox, db.settings, async () => {
      const current = await db.meetings.get(meetingId);
      if (!current) throw new MeetingNotFoundError(meetingId);
      if ((current.status === "trashed") === trashed) return current;
      const settingKey = restoreSettingKey(meetingId);
      const prior = RestoreStatusSchema.safeParse((await db.settings.get(settingKey))?.value);
      const meeting = MeetingSchema.parse({
        ...current,
        status: trashed ? "trashed" : (prior.success ? prior.data : "draft"),
        trashedAt: trashed ? updatedAt : null,
        updatedAt,
        syncVersion: current.syncVersion + 1,
      });
      if (trashed) await db.settings.put({ key: settingKey, value: current.status });
      else await db.settings.delete(settingKey);
      await db.meetings.put(meeting);
      await this.enqueueOutbox(db, operation(trashed ? "meeting.trash" : "meeting.restore", meetingId, { updatedAt, expectedSyncVersion: current.syncVersion }, updatedAt));
      return meeting;
    });
  }

  async renameFolder(id: string, name: string, now: string): Promise<Folder> {
    const db = this.db;
    const folderId = MeetingIdSchema.parse(id);
    const normalizedName = FolderNameSchema.parse(name);
    const updatedAt = timestamp(now);
    return db.transaction("rw", db.folders, db.outbox, async () => {
      const current = await db.folders.get(folderId);
      if (!current) throw new FolderNotFoundError(folderId);
      const folder = FolderSchema.parse({ ...current, name: normalizedName, updatedAt, syncVersion: current.syncVersion + 1 });
      await db.folders.put(folder);
      await this.enqueueOutbox(db, operation("folder.rename", folderId, { name: normalizedName, updatedAt, expectedSyncVersion: current.syncVersion }, updatedAt));
      return folder;
    });
  }

  async removeFolder(id: string, now: string): Promise<void> {
    const db = this.db;
    const folderId = MeetingIdSchema.parse(id);
    const updatedAt = timestamp(now);
    await db.transaction("rw", db.meetings, db.folders, db.outbox, async () => {
      const currentFolder = await db.folders.get(folderId);
      if (!currentFolder) throw new FolderNotFoundError(folderId);
      const meetings = await db.meetings.where("folderId").equals(folderId).toArray();
      await Promise.all(meetings.map((meeting) => db.meetings.put(MeetingSchema.parse({
        ...meeting, folderId: null, updatedAt, syncVersion: meeting.syncVersion + 1,
      }))));
      await db.folders.delete(folderId);
      await this.enqueueOutbox(db, operation("folder.remove", folderId, { updatedAt, expectedSyncVersion: currentFolder.syncVersion }, updatedAt));
    });
  }

  async authorizeDevice(userId: string, sessionExpiresAt: string, now: string): Promise<DeviceAccess> {
    const access = DeviceAccessSchema.parse({ userId, authorizedAt: timestamp(now), expiresAt: timestamp(sessionExpiresAt) });
    if (this.activeUserId !== null && this.activeUserId !== access.userId) throw new Error("USER_CONTEXT_MISMATCH");
    await this.bootstrapDb.settings.put({ key: "deviceAccess", value: access });
    return access;
  }

  async refreshDeviceAccess(userIdInput: string, sessionExpiresAt: string): Promise<DeviceAccess | null> {
    const userId = UserIdSchema.parse(userIdInput);
    const expiresAt = timestamp(sessionExpiresAt);
    return this.bootstrapDb.transaction("rw", this.bootstrapDb.settings, async () => {
      const current = DeviceAccessSchema.safeParse((await this.bootstrapDb.settings.get("deviceAccess"))?.value);
      if (!current.success || current.data.userId !== userId) return null;
      if (expiresAt <= current.data.expiresAt) return current.data;
      const refreshed = DeviceAccessSchema.parse({ ...current.data, expiresAt });
      await this.bootstrapDb.settings.put({ key: "deviceAccess", value: refreshed });
      return refreshed;
    });
  }

  async hasDeviceAccess(now: string): Promise<boolean> {
    return (await this.validDeviceAccess(now)) !== null;
  }

  async validDeviceAccess(now: string): Promise<DeviceAccess | null> {
    const setting = await this.bootstrapDb.settings.get("deviceAccess");
    const access = DeviceAccessSchema.safeParse(setting?.value);
    return access.success && timestamp(now) < timestamp(access.data.expiresAt) ? access.data : null;
  }

  async clearDeviceAccess(expected?: DeviceAccess): Promise<void> {
    await this.bootstrapDb.transaction("rw", this.bootstrapDb.settings, async () => {
      const current = DeviceAccessSchema.safeParse((await this.bootstrapDb.settings.get("deviceAccess"))?.value);
      if (!expected || (current.success && current.data.userId === expected.userId && current.data.authorizedAt === expected.authorizedAt && current.data.expiresAt === expected.expiresAt)) {
        await this.bootstrapDb.settings.delete("deviceAccess");
      }
    });
  }

  async syncApplySuccessfulOperation(operationToApply: OutboxOperation, response: { meeting?: unknown; folder?: unknown }): Promise<void> {
    const db = this.operationSource(operationToApply);
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

    await db.transaction("rw", db.meetings, db.folders, db.outbox, async () => {
      const pending = await db.outbox.toArray();
      const hasLaterEntityMutation = pending.some((item) => item.entityId === operationToApply.entityId && item.sequence !== undefined && item.sequence > sequence);
      const pendingFolderRemovals = new Set(pending
        .filter((item) => item.kind === "folder.remove" && item.sequence !== sequence)
        .map((item) => item.entityId));

      if (operationToApply.kind === "folder.remove") {
        const meetings = await db.meetings.where("folderId").equals(operationToApply.entityId).toArray();
        await Promise.all(meetings.map((meeting) => db.meetings.put(MeetingSchema.parse({ ...meeting, folderId: null }))));
        await db.folders.delete(operationToApply.entityId);
      } else if (!hasLaterEntityMutation) {
        if (receivedMeeting) {
          const current = await db.meetings.get(receivedMeeting.id);
          if (!current || current.syncVersion <= receivedMeeting.syncVersion) {
            await db.meetings.put(MeetingSchema.parse({
              ...receivedMeeting,
              folderId: receivedMeeting.folderId && pendingFolderRemovals.has(receivedMeeting.folderId) ? null : receivedMeeting.folderId,
            }));
          }
        }
        if (receivedFolder && !pendingFolderRemovals.has(receivedFolder.id)) {
          const current = await db.folders.get(receivedFolder.id);
          if (!current || current.syncVersion <= receivedFolder.syncVersion) await db.folders.put(receivedFolder);
        }
      }
      await db.outbox.delete(sequence);
    });
  }

  async syncRecordFailure(operationToUpdate: OutboxOperation, error: "SYNC_FAILED" | "AUTH_REQUIRED" | "CONFLICT"): Promise<void> {
    const db = this.operationSource(operationToUpdate);
    const sequence = z.number().int().nonnegative().parse(operationToUpdate.sequence);
    await db.outbox.update(sequence, {
      lastError: error,
      ...(error === "SYNC_FAILED" ? { attempts: operationToUpdate.attempts + 1 } : {}),
    });
  }

  async syncRefresh(foldersInput: unknown, meetingsInput: unknown): Promise<void> {
    const db = this.db;
    const folders = z.array(FolderSchema).parse(foldersInput);
    const meetings = z.array(MeetingSchema).parse(meetingsInput);
    await db.transaction("rw", db.meetings, db.folders, db.outbox, async () => {
      const operations = await db.outbox.toArray();
      const pendingEntityIds = new Set(operations.map((item) => item.entityId));
      const remoteFolderIds = new Set(folders.map((folder) => folder.id));
      const remoteMeetingIds = new Set(meetings.map((meeting) => meeting.id));

      for (const local of await db.folders.toArray()) {
        if (!pendingEntityIds.has(local.id) && !remoteFolderIds.has(local.id)) await db.folders.delete(local.id);
      }
      for (const folder of folders) {
        if (!pendingEntityIds.has(folder.id)) await db.folders.put(folder);
      }

      for (const local of await db.meetings.toArray()) {
        if (!pendingEntityIds.has(local.id) && !remoteMeetingIds.has(local.id)) await db.meetings.delete(local.id);
      }
      const availableFolderIds = new Set((await db.folders.toArray()).map((folder) => folder.id));
      for (const meeting of meetings) {
        if (!pendingEntityIds.has(meeting.id)) {
          await db.meetings.put(MeetingSchema.parse({
            ...meeting,
            folderId: meeting.folderId && availableFolderIds.has(meeting.folderId) ? meeting.folderId : null,
          }));
        }
      }

      for (const local of await db.meetings.toArray()) {
        if (local.folderId && !availableFolderIds.has(local.folderId)) {
          await db.meetings.put(MeetingSchema.parse({ ...local, folderId: null }));
          const create = operations.find((operation) => operation.entityId === local.id && operation.kind === "meeting.create");
          if (create?.sequence !== undefined) {
            const payload = CreateMeetingInputSchema.parse(create.payload);
            await db.outbox.update(create.sequence, {
              payload: CreateMeetingInputSchema.parse({ ...payload, folderId: null }),
            });
          }
        }
      }
    });
  }
}
