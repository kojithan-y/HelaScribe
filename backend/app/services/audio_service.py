import io
import math
import re
import struct
import subprocess
import wave
from pathlib import Path

from imageio_ffmpeg import get_ffmpeg_exe


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


def audio_duration_seconds(path: str | Path) -> float | None:
    """Read the duration of any FFmpeg-supported audio file."""
    completed = subprocess.run(
        [get_ffmpeg_exe(), "-i", str(Path(path).resolve()), "-f", "null", "NUL"],
        check=False,
        capture_output=True,
        text=True,
    )
    output = completed.stderr
    match = re.search(r"Duration: (\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)", output)
    if not match:
        return None
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
