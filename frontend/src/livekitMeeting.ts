import type { Segment } from "./types";

export type MeetingParticipantView = { identity: string; name: string };

export type MeetingCallbacks = {
  onConnectionChange: (status: string) => void;
  onParticipantsChange: (participants: MeetingParticipantView[]) => void;
  onSegment: (segment: Segment) => void;
  onError: (error: Error) => void;
};

export interface MeetingClient {
  disconnect: () => Promise<void>;
}

export type ConnectMeeting = (
  url: string,
  token: string,
  callbacks: MeetingCallbacks,
) => Promise<MeetingClient>;
