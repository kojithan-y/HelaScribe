export type Language = "Sinhala" | "Tamil" | "English" | "Mixed";
export type SessionType = "Record" | "Live" | "Upload" | "Meeting";
export type JobStatus = "queued" | "processing" | "completed" | "failed";
export type ProcessingStage = "recording" | "saving_audio" | "transcribing" | "diarizing";
export type SpokenLanguage = "Sinhala" | "Tamil" | "English" | "Unknown";

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
  detected_language?: SpokenLanguage | null;
  participant_identity?: string | null;
}

export interface MeetingParticipant {
  identity: string;
  display_name: string;
  shared_mic: boolean;
}

export interface TranscriptRecord {
  id: string;
  title: string;
  language: Language;
  session_type: SessionType;
  diarization: boolean;
  status: JobStatus;
  processing_stage?: ProcessingStage | null;
  transcript: string;
  segments: Segment[];
  duration_seconds?: number | null;
  audio_filename?: string | null;
  participant_audio?: Record<string, string>;
  participants?: MeetingParticipant[];
  error?: string | null;
  created_at: string;
}

export interface MeetingConnection {
  livekit_url: string;
  token: string;
  room_code: string;
  meeting_id: string;
  participant_identity: string;
  display_name: string;
  is_host: boolean;
  host_secret?: string | null;
}
