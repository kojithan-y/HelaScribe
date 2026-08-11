import { File as ExpoFile } from "expo-file-system";
import { Platform } from "react-native";

import type { Language, MeetingConnection, SessionType, TranscriptRecord } from "./types";

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
