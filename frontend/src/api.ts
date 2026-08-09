import type { Language, SessionType, TranscriptRecord } from "./types";

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000/api";
export const WS_URL = API_URL.replace(/^http/, "ws") + "/live";

export function getAudioUrl(id: string): string {
  return `${API_URL}/history/${encodeURIComponent(id)}/audio`;
}

export async function getHistory(): Promise<TranscriptRecord[]> {
  const response = await fetch(`${API_URL}/history`);
  if (!response.ok) throw new Error("Could not load transcript history");
  return response.json();
}

export async function getTranscript(id: string): Promise<TranscriptRecord> {
  const response = await fetch(`${API_URL}/history/${id}`);
  if (!response.ok) throw new Error("Could not load transcript");
  return response.json();
}

export async function submitAudio(
  uri: string,
  name: string,
  mimeType: string,
  language: Language,
  sessionType: Exclude<SessionType, "Live">,
  diarization: boolean,
  browserFile?: Blob,
  durationSeconds?: number,
): Promise<{ id: string; status: string }> {
  const form = new FormData();
  if (browserFile) {
    form.append("file", browserFile, name);
  } else if (uri.startsWith("blob:")) {
    form.append("file", await (await fetch(uri)).blob(), name);
  } else {
    form.append("file", { uri, name, type: mimeType } as unknown as Blob);
  }
  form.append("language", language);
  form.append("session_type", sessionType);
  form.append("diarization", String(diarization));
  if (durationSeconds && durationSeconds > 0) {
    form.append("duration_seconds", String(durationSeconds));
  }
  form.append("title", `${sessionType} • ${new Date().toLocaleString()}`);
  const response = await fetch(`${API_URL}/transcribe`, { method: "POST", body: form });
  if (!response.ok) throw new Error((await response.text()) || "Upload failed");
  return response.json();
}
