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
