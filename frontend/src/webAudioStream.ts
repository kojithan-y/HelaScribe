const TARGET_SAMPLE_RATE = 16000;

export type WebAudioStream = {
  stop: () => Promise<void>;
};

type SafariWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

function pcm16Buffer(input: Float32Array, inputSampleRate: number): ArrayBuffer {
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const sampleCount = Math.max(1, Math.round(input.length / ratio));
  const output = new ArrayBuffer(sampleCount * 2);
  const view = new DataView(output);

  for (let index = 0; index < sampleCount; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    const sample = input[left]! + (input[right]! - input[left]!) * fraction;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return output;
}

export async function startWebAudioStream(
  onBuffer: (buffer: ArrayBuffer, level: number) => void,
): Promise<WebAudioStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture requires HTTPS or localhost in this browser");
  }

  const AudioContextConstructor =
    window.AudioContext ?? (window as SafariWindow).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("Web Audio is not supported by this browser");
  }

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  let context: AudioContext | null = null;
  try {
    context = new AudioContextConstructor({ sampleRate: TARGET_SAMPLE_RATE });
    const source = context.createMediaStreamSource(mediaStream);
    const silentOutput = context.createGain();
    silentOutput.gain.value = 0;

    const emit = (samples: Float32Array, sampleRate: number) => {
      let sumSquares = 0;
      for (let index = 0; index < samples.length; index += 1) {
        sumSquares += samples[index]! * samples[index]!;
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
      onBuffer(pcm16Buffer(samples, sampleRate), Math.min(1, rms * 5));
    };

    let disconnectProcessor: () => void;
    if (context.audioWorklet) {
      const workletSource = `
        class HelaScribeCapture extends AudioWorkletProcessor {
          process(inputs) {
            const channel = inputs[0] && inputs[0][0];
            if (channel && channel.length) this.port.postMessage(channel.slice(0));
            return true;
          }
        }
        registerProcessor("helascribe-capture", HelaScribeCapture);
      `;
      const moduleUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
      try {
        await context.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      const worklet = new AudioWorkletNode(context, "helascribe-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => emit(event.data, context!.sampleRate);
      source.connect(worklet);
      worklet.connect(silentOutput);
      disconnectProcessor = () => {
        worklet.port.onmessage = null;
        source.disconnect(worklet);
        worklet.disconnect();
      };
    } else {
      // Compatibility fallback for older embedded browsers.
      const legacy = context.createScriptProcessor(4096, 1, 1);
      legacy.onaudioprocess = (event) => emit(event.inputBuffer.getChannelData(0), event.inputBuffer.sampleRate);
      source.connect(legacy);
      legacy.connect(silentOutput);
      disconnectProcessor = () => {
        legacy.onaudioprocess = null;
        source.disconnect(legacy);
        legacy.disconnect();
      };
    }
    silentOutput.connect(context.destination);
    await context.resume();

    let stopped = false;
    return {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        disconnectProcessor();
        silentOutput.disconnect();
        mediaStream.getTracks().forEach((track) => track.stop());
        if (context?.state !== "closed") await context?.close();
      },
    };
  } catch (error) {
    mediaStream.getTracks().forEach((track) => track.stop());
    if (context?.state !== "closed") await context?.close();
    throw error;
  }
}
