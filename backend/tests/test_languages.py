from app.models.schemas import Language, SpokenLanguage, TranscriptSegment
from app.services.gemini_service import (
    LANGUAGE_GUIDANCE,
    bound_segments_to_duration,
    detect_script_language,
    normalize_language_segments,
)


def segment(text: str) -> TranscriptSegment:
    return TranscriptSegment(start=0, end=1, text=text)


def test_script_detection_covers_supported_languages() -> None:
    assert detect_script_language("සිංහල") == SpokenLanguage.sinhala
    assert detect_script_language("தமிழ்") == SpokenLanguage.tamil
    assert detect_script_language("English") == SpokenLanguage.english
    assert detect_script_language("123") == SpokenLanguage.unknown


def test_monolingual_mode_filters_other_scripts() -> None:
    result = normalize_language_segments(
        [segment("தமிழ்"), segment("සිංහල")],
        Language.tamil,
    )

    assert [item.text for item in result] == ["தமிழ்"]
    assert result[0].detected_language == SpokenLanguage.tamil


def test_mixed_mode_labels_each_native_script() -> None:
    result = normalize_language_segments(
        [segment("Hello"), segment("සිංහල"), segment("தமிழ்")],
        Language.mixed,
    )

    assert [item.detected_language for item in result] == [
        SpokenLanguage.english,
        SpokenLanguage.sinhala,
        SpokenLanguage.tamil,
    ]


def test_prompts_explicitly_separate_single_and_mixed_modes() -> None:
    assert "speech only" in LANGUAGE_GUIDANCE[Language.sinhala]
    assert "speech only" in LANGUAGE_GUIDANCE[Language.tamil]
    assert "speech only" in LANGUAGE_GUIDANCE[Language.english]
    assert "Transcribe all three" in LANGUAGE_GUIDANCE[Language.mixed]


def test_segments_cannot_extend_beyond_real_audio() -> None:
    result = bound_segments_to_duration(
        [
            TranscriptSegment(start=0.5, end=1.5, text="partly valid"),
            TranscriptSegment(start=2, end=3, text="hallucinated tail"),
        ],
        1.0,
    )

    assert [(item.start, item.end, item.text) for item in result] == [
        (0.5, 1.0, "partly valid")
    ]
