import { Room, RoomEvent, Track } from "livekit-client";
import type { ConnectMeeting, MeetingParticipantView } from "./livekitMeeting";

export const connectMeeting: ConnectMeeting = async (url, token, callbacks) => {
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const participants = (): MeetingParticipantView[] => [
    { identity: room.localParticipant.identity, name: room.localParticipant.name || room.localParticipant.identity },
    ...[...room.remoteParticipants.values()].map((item) => ({
      identity: item.identity,
      name: item.name || item.identity,
    })),
  ].filter((item) => item.identity);
  const updateParticipants = () => callbacks.onParticipantsChange(participants());

  room.on(RoomEvent.ParticipantConnected, updateParticipants);
  room.on(RoomEvent.ParticipantDisconnected, updateParticipants);
  room.on(RoomEvent.Reconnecting, () => callbacks.onConnectionChange("reconnecting"));
  room.on(RoomEvent.Reconnected, () => callbacks.onConnectionChange("connected"));
  room.on(RoomEvent.Disconnected, () => callbacks.onConnectionChange("disconnected"));
  room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
    if (topic !== "transcript.segment") return;
    try {
      const message = JSON.parse(new TextDecoder().decode(payload));
      if (message.type === "transcript" && message.segment) callbacks.onSegment(message.segment);
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error("Invalid transcript event"));
    }
  });
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;
    const element = track.attach();
    element.dataset.livekitMeetingAudio = "true";
    document.body.appendChild(element);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach().forEach((element) => element.remove());
  });

  callbacks.onConnectionChange("connecting");
  await room.connect(url, token);
  await room.startAudio();
  await room.localParticipant.setMicrophoneEnabled(true);
  callbacks.onConnectionChange("connected");
  updateParticipants();
  return {
    disconnect: async () => {
      await room.localParticipant.setMicrophoneEnabled(false);
      document.querySelectorAll("[data-livekit-meeting-audio='true']").forEach((element) => element.remove());
      await room.disconnect();
    },
  };
};
