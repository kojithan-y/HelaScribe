export type Language = "Sinhala" | "Tamil" | "English" | "Mixed";
export type SessionType = "Record" | "Live" | "Upload";
export type JobStatus = "queued" | "processing" | "completed" | "failed";
export type SpokenLanguage = "Sinhala" | "Tamil" | "English" | "Unknown";

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
  detected_language?: SpokenLanguage | null;
}

export interface TranscriptRecord {
  id: string;
  title: string;
  language: Language;
  session_type: SessionType;
  diarization: boolean;
  status: JobStatus;
  transcript: string;
  segments: Segment[];
  duration_seconds?: number | null;
  audio_filename?: string | null;
  error?: string | null;
  created_at: string;
}
