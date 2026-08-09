import io
import math
import struct
import wave


def pcm_rms(pcm: bytes) -> float:
    """Return DC-adjusted RMS for little-endian signed PCM16 audio."""
    sample_bytes = len(pcm) - (len(pcm) % 2)
    if not sample_bytes:
        return 0.0
    samples = [sample[0] for sample in struct.iter_unpack("<h", pcm[:sample_bytes])]
    mean = sum(samples) / len(samples)
    return math.sqrt(sum((sample - mean) ** 2 for sample in samples) / len(samples))


def wav_rms(audio: bytes) -> float | None:
    """Read mono/stereo 16-bit WAV energy, or return None for another encoding."""
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            if wav.getsampwidth() != 2:
                return None
            return pcm_rms(wav.readframes(wav.getnframes()))
    except (wave.Error, EOFError):
        return None
