import { File as ExpoFile } from "expo-file-system";
import { Platform } from "react-native";

import type { Language, MeetingConnection, SessionType, TranscriptRecord, TranscriptSummary } from "./types";

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:8000/api";
export const WS_URL = API_URL.replace(/^http/, "ws") + "/live";
export const HISTORY_WS_URL = API_URL.replace(/^http/, "ws") + "/history/events";

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

export async function updateTranscript(
  id: string,
  patch: { title?: string; segments?: TranscriptRecord["segments"] },
): Promise<TranscriptRecord> {
  const response = await fetch(`${API_URL}/history/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error((await response.text()) || "Could not update transcript");
  return response.json();
}

export async function renameTranscriptSpeaker(
  id: string,
  oldName: string,
  newName: string,
): Promise<TranscriptRecord> {
  const response = await fetch(`${API_URL}/history/${encodeURIComponent(id)}/speakers/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ old_name: oldName, new_name: newName }),
  });
  if (!response.ok) throw new Error((await response.text()) || "Could not rename speaker");
  return response.json();
}

export async function translateTranscript(id: string, targetLanguage: Language): Promise<TranscriptRecord> {
  const response = await fetch(`${API_URL}/history/${encodeURIComponent(id)}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_language: targetLanguage }),
  });
  if (!response.ok) throw new Error((await response.text()) || "Could not translate transcript");
  return response.json();
}

async function jobAction(id: string, action: "cancel" | "retry"): Promise<{ id: string; status: string }> {
  const response = await fetch(`${API_URL}/transcribe/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  if (!response.ok) throw new Error((await response.text()) || `Could not ${action} job`);
  return response.json();
}

export const cancelTranscription = (id: string) => jobAction(id, "cancel");
export const retryTranscription = (id: string) => jobAction(id, "retry");

export async function deleteTranscript(id: string): Promise<void> {
  const response = await fetch(`${API_URL}/history/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error((await response.text()) || "Could not delete transcript");
}

export async function generateTranscriptSummary(id: string): Promise<TranscriptSummary> {
  const response = await fetch(`${API_URL}/history/${encodeURIComponent(id)}/summary`, { method: "POST" });
  if (!response.ok) {
    let message = "Could not generate summary";
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") message = body.detail;
    } catch { /* Keep the user-friendly fallback for non-JSON responses. */ }
    throw new Error(message);
  }
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
    // Expo's native fetch implementation serializes Blob-like values itself.
    // The legacy React Native `{ uri, name, type }` object is deliberately not
    // supported by that serializer in SDK 57 and throws
    // "Unsupported FormDataPart implementation".
    if (Platform.OS === "web") {
      throw new Error("The selected audio file could not be read");
    }
    form.append("file", new ExpoFile(uri), name);
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

async function meetingRequest(path: string, body: unknown): Promise<MeetingConnection> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.text()) || "Meeting request failed");
  return response.json();
}

export function createMeeting(
  displayName: string,
  language: Language,
  sharedMic: boolean,
): Promise<MeetingConnection> {
  return meetingRequest("/meetings", {
    display_name: displayName,
    language,
    shared_mic: sharedMic,
  });
}

export function joinMeeting(
  roomCode: string,
  displayName: string,
  sharedMic: boolean,
): Promise<MeetingConnection> {
  return meetingRequest(`/meetings/${encodeURIComponent(roomCode.trim().toUpperCase())}/join`, {
    display_name: displayName,
    shared_mic: sharedMic,
  });
}

export async function endMeeting(roomCode: string, hostSecret: string): Promise<{ id: string; status: string }> {
  const response = await fetch(`${API_URL}/meetings/${encodeURIComponent(roomCode)}/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host_secret: hostSecret }),
  });
  if (!response.ok) throw new Error((await response.text()) || "Could not end meeting");
  return response.json();
}
