import type { ConnectMeeting } from "./livekitMeeting";

export const connectMeeting: ConnectMeeting = async () => {
  throw new Error(
    "Meeting needs a browser or the HelaScribe Android development build; Expo Go does not include LiveKit WebRTC.",
  );
};
