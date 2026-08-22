import { z } from "zod";

export const MeetingStatusSchema = z.enum([
  "draft",
  "recording",
  "recoverable",
  "uploading",
  "processing",
  "ready",
  "failed",
  "trashed",
]);

const MeetingIdSchema = z.uuid();
const MeetingTitleSchema = z.string().trim().min(1).max(120);
const FolderNameSchema = z.string().trim().min(1).max(80);
const IsoDateTimeSchema = z.iso.datetime();
const SyncVersionSchema = z.int().nonnegative();
export const ExpectedSyncVersionSchema = SyncVersionSchema;
export const IdempotencyKeySchema = z.uuid();

export const CreateMeetingInputSchema = z.object({
  id: MeetingIdSchema,
  title: MeetingTitleSchema,
  folderId: MeetingIdSchema.nullable(),
  clientCreatedAt: IsoDateTimeSchema,
});

export const CreateFolderInputSchema = z.object({
  id: MeetingIdSchema,
  name: FolderNameSchema,
  clientCreatedAt: IsoDateTimeSchema,
});

export const MeetingMutationBodySchema = z.object({ expectedSyncVersion: ExpectedSyncVersionSchema }).strict();
export const FolderMutationBodySchema = MeetingMutationBodySchema;
export const MeetingPatchBodySchema = z.object({
  title: MeetingTitleSchema.optional(),
  folderId: MeetingIdSchema.nullable().optional(),
  expectedSyncVersion: ExpectedSyncVersionSchema,
}).strict().refine((value) => value.title !== undefined || value.folderId !== undefined);
export const FolderRenameBodySchema = z.object({ name: FolderNameSchema, expectedSyncVersion: ExpectedSyncVersionSchema }).strict();
export const LegacyMeetingPatchBodySchema = z.object({ title: MeetingTitleSchema }).strict();
export const LegacyFolderRenameBodySchema = z.object({ name: FolderNameSchema }).strict();
export const MeetingPatchWireBodySchema = z.union([MeetingPatchBodySchema, LegacyMeetingPatchBodySchema]);
export const FolderRenameWireBodySchema = z.union([FolderRenameBodySchema, LegacyFolderRenameBodySchema]);

export const FolderSchema = z.object({
  id: MeetingIdSchema,
  name: FolderNameSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  syncVersion: SyncVersionSchema,
});

export const MeetingSchema = z.object({
  id: MeetingIdSchema,
  title: MeetingTitleSchema,
  folderId: MeetingIdSchema.nullable(),
  status: MeetingStatusSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  trashedAt: IsoDateTimeSchema.nullable(),
  syncVersion: SyncVersionSchema,
});

export const MeetingListQuerySchema = z.object({
  search: z.string().trim().max(120).default(""),
  includeTrashed: z.preprocess(
    (value) => {
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    },
    z.boolean().default(false),
  ),
});

export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;
export type CreateMeetingInput = z.infer<typeof CreateMeetingInputSchema>;
export type Meeting = z.infer<typeof MeetingSchema>;
export type CreateFolderInput = z.infer<typeof CreateFolderInputSchema>;
export type Folder = z.infer<typeof FolderSchema>;
export type MeetingMutationBody = z.infer<typeof MeetingMutationBodySchema>;
export type FolderMutationBody = z.infer<typeof FolderMutationBodySchema>;
export type MeetingListQuery = z.output<typeof MeetingListQuerySchema>;
export type MeetingListQueryInput = z.input<typeof MeetingListQuerySchema>;
