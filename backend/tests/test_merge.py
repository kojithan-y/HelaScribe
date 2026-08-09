import pytest
from pydantic import ValidationError

from app.models.schemas import SpokenLanguage, TranscriptSegment
from app.services.diarization_service import merge_transcript_and_speakers


def test_merge_uses_largest_overlap() -> None:
    transcript = [TranscriptSegment(start=1, end=4, text="hello")]
    speakers = [
        TranscriptSegment(start=0, end=2, text="", speaker="SPEAKER_00"),
        TranscriptSegment(start=2, end=5, text="", speaker="SPEAKER_01"),
    ]
    assert merge_transcript_and_speakers(transcript, speakers)[0].speaker == "SPEAKER_01"


def test_merge_marks_no_overlap_unknown_and_preserves_language() -> None:
    transcript = [
        TranscriptSegment(
            start=10,
            end=11,
            text="hello",
            detected_language=SpokenLanguage.english,
        )
    ]
    speakers = [TranscriptSegment(start=0, end=1, text="", speaker="SPEAKER_00")]

    merged = merge_transcript_and_speakers(transcript, speakers)

    assert merged[0].speaker == "SPEAKER_UNKNOWN"
    assert merged[0].detected_language == SpokenLanguage.english


def test_segment_rejects_reversed_timestamps() -> None:
    with pytest.raises(ValidationError):
        TranscriptSegment(start=2, end=1, text="invalid")
