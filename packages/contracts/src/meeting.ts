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
export const MeetingNoteSchema = z.string()
  .max(400_000, "Meeting note must contain at most 400,000 UTF-16 code units")
  .superRefine((value, context) => {
    let codePoints = 0;
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit === 0) {
        context.addIssue({ code: "custom", message: "Meeting note cannot contain NUL characters" });
        return;
      }
      if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
        const trailing = value.charCodeAt(index + 1);
        if (trailing < 0xDC00 || trailing > 0xDFFF) {
          context.addIssue({ code: "custom", message: "Meeting note must contain only valid Unicode scalar values" });
          return;
        }
        index += 1;
      } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
        context.addIssue({ code: "custom", message: "Meeting note must contain only valid Unicode scalar values" });
        return;
      }
      codePoints += 1;
      if (codePoints > 200_000) {
        context.addIssue({ code: "custom", message: "Meeting note must contain at most 200,000 characters" });
        return;
      }
    }
  });
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
export const MeetingNoteBodySchema = z.object({
  note: MeetingNoteSchema,
  expectedSyncVersion: ExpectedSyncVersionSchema,
}).strict();
export const MeetingNoteOperationSchema = MeetingNoteBodySchema.extend({
  updatedAt: IsoDateTimeSchema,
}).strict();
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
  note: MeetingNoteSchema.default(""),
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
export type MeetingNoteBody = z.infer<typeof MeetingNoteBodySchema>;
export type MeetingNoteOperation = z.infer<typeof MeetingNoteOperationSchema>;
export type FolderMutationBody = z.infer<typeof FolderMutationBodySchema>;
export type MeetingListQuery = z.output<typeof MeetingListQuerySchema>;
export type MeetingListQueryInput = z.input<typeof MeetingListQuerySchema>;
