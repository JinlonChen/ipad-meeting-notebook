import type { Folder, Meeting, Minutes, TranscriptSegment } from "@meeting/contracts";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type FolderRow = {
  user_id: string;
  id: Folder["id"];
  name: Folder["name"];
  created_at: Folder["createdAt"];
  updated_at: Folder["updatedAt"];
  sync_version: Folder["syncVersion"];
};

export type MeetingRow = {
  user_id: string;
  id: Meeting["id"];
  title: Meeting["title"];
  folder_id: Meeting["folderId"];
  status: Meeting["status"];
  started_at: Meeting["startedAt"];
  ended_at: Meeting["endedAt"];
  created_at: Meeting["createdAt"];
  updated_at: Meeting["updatedAt"];
  trashed_at: Meeting["trashedAt"];
  status_before_trash: Exclude<Meeting["status"], "trashed"> | null;
  sync_version: Meeting["syncVersion"];
  note: Meeting["note"];
};

export type CatalogMutationReplayRow = {
  user_id: string;
  operation_id: string;
  operation_kind: string;
  request_fingerprint: string;
  response: Json;
  created_at: string;
};

export type MeetingAudioChunkRow = {
  user_id: string;
  meeting_id: string;
  sequence: number;
  bucket_id: "meeting-audio";
  remote_path: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  captured_at: string;
  expires_at: string;
  created_at: string;
};

export type MeetingIntelligenceJobRow = {
  user_id: string;
  meeting_id: string;
  status: "queued" | "processing" | "ready" | "failed";
  error_code: string | null;
  requested_at: string;
  completed_at: string | null;
};

export type MeetingTranscriptSegmentRow = {
  user_id: string;
  id: TranscriptSegment["id"];
  meeting_id: TranscriptSegment["meetingId"];
  position: number;
  text: string;
  started_offset_ms: number;
  ended_offset_ms: number;
  speaker: string | null;
  source: TranscriptSegment["source"];
  confidence: number | null;
  created_at: string;
  updated_at: string;
};

export type MeetingMinutesRow = {
  user_id: string;
  meeting_id: string;
  summary: Minutes["summary"];
  topics: Minutes["topics"];
  decisions: Minutes["decisions"];
  risks: Minutes["risks"];
  actions: Minutes["actions"];
  provider: string;
  model: string;
  generated_at: string;
};

export type ApplyCatalogMutationArgs = {
  p_operation_id: string;
  p_kind: string;
  p_entity_id: string;
  p_payload: Json;
  p_expected_user_id: string;
};

export type ApplyCatalogMutationResult = {
  status: number;
  code?: string;
  meeting?: MeetingRow;
  folder?: FolderRow;
};

export type ApplyMeetingNoteMutationArgs = {
  p_operation_id: string;
  p_entity_id: string;
  p_note: string;
  p_updated_at: string;
  p_expected_sync_version: number;
  p_expected_user_id: string;
};

export type CatalogSnapshotResult = {
  status: number;
  code?: string;
  folders?: FolderRow[];
  meetings?: MeetingRow[];
};

export type Database = {
  public: {
    Tables: {
      folders: {
        Row: FolderRow;
        Insert: FolderRow;
        Update: Partial<FolderRow>;
        Relationships: [];
      };
      meetings: {
        Row: MeetingRow;
        Insert: MeetingRow;
        Update: Partial<MeetingRow>;
        Relationships: [
          {
            foreignKeyName: "meetings_user_id_folder_id_fkey";
            columns: ["user_id", "folder_id"];
            isOneToOne: false;
            referencedRelation: "folders";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      catalog_mutation_replays: {
        Row: CatalogMutationReplayRow;
        Insert: Omit<CatalogMutationReplayRow, "created_at"> & { created_at?: string };
        Update: Partial<CatalogMutationReplayRow>;
        Relationships: [];
      };
      meeting_audio_chunks: {
        Row: MeetingAudioChunkRow;
        Insert: Omit<MeetingAudioChunkRow, "bucket_id" | "created_at"> & {
          bucket_id?: "meeting-audio";
          created_at?: string;
        };
        Update: Partial<MeetingAudioChunkRow>;
        Relationships: [
          {
            foreignKeyName: "meeting_audio_chunks_user_id_meeting_id_fkey";
            columns: ["user_id", "meeting_id"];
            isOneToOne: false;
            referencedRelation: "meetings";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      meeting_intelligence_jobs: {
        Row: MeetingIntelligenceJobRow;
        Insert: MeetingIntelligenceJobRow;
        Update: Partial<MeetingIntelligenceJobRow>;
        Relationships: [];
      };
      meeting_transcript_segments: {
        Row: MeetingTranscriptSegmentRow;
        Insert: MeetingTranscriptSegmentRow;
        Update: Partial<MeetingTranscriptSegmentRow>;
        Relationships: [];
      };
      meeting_minutes: {
        Row: MeetingMinutesRow;
        Insert: MeetingMinutesRow;
        Update: Partial<MeetingMinutesRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      apply_catalog_mutation: {
        Args: ApplyCatalogMutationArgs;
        Returns: ApplyCatalogMutationResult;
      };
      apply_meeting_note_mutation: {
        Args: ApplyMeetingNoteMutationArgs;
        Returns: ApplyCatalogMutationResult;
      };
      get_catalog_snapshot: {
        Args: { p_expected_user_id: string };
        Returns: CatalogSnapshotResult;
      };
      ai_provider_configured: {
        Args: Record<string, never>;
        Returns: boolean;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
