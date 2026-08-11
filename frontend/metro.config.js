const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "helascribe-meeting-connector") {
    const nativeLiveKitEnabled = process.env.HELASCRIBE_LIVEKIT_NATIVE === "1";
    const implementation = platform === "web"
      ? "src/livekitMeetingImpl.web.ts"
      : nativeLiveKitEnabled
        ? "src/livekitMeetingImpl.native.ts"
        : "src/livekitMeetingStub.ts";
    return { filePath: path.resolve(__dirname, implementation), type: "sourceFile" };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
