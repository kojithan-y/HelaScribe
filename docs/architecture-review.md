# HelaScribe architecture and product review

Reviewed 2026-08-09. This document records why the current orchestration exists, what was changed, and what remains before a public production launch.

## Outcome

Keep the two-stage design:

1. Gemini provides script-preserving transcription for Sinhala, Tamil, English, and three-language code-switching.
2. Gemini provides anonymous speaker labels in the authoritative pass when requested; pyannote Community-1 refines them with language-independent diarization after the transcript is stable.
3. Record and Upload use one full-audio pass. Live uses short provisional chunks for responsiveness, then a full-audio quality pass at stop and finally diarization.
4. Optional multi-user Meeting sessions use LiveKit Cloud as transport only. Each remote participant remains a separate audio track; Gemini still performs recognition, and pyannote is restricted to tracks explicitly marked as shared microphones.

This deliberately separates *what was said* from *who spoke when*. Speaker labels such as `SPEAKER_00` differentiate voices; they do not identify a person's real-world identity. Named identity requires an explicit enrollment/voiceprint and consent design.

## Comparable systems and missing product behavior

- Otter groups speech by speaker and can use enrolled speaker data to attach names. HelaScribe currently differentiates anonymous voices but has no speaker enrollment or rename workflow: https://help.otter.ai/hc/en-us/articles/21665587209367-Speaker-Identification-Overview
- Notta exposes speaker identification across meeting transcription languages, while its monolingual list includes Tamil. Its published language list does not establish Sinhala support: https://support.notta.ai/hc/en-us/articles/4403155631131-What-languages-does-Notta-support and https://support.notta.ai/hc/en-us/articles/4403163792027-Does-Notta-support-speaker-identification
- Mature meeting tools also set expectations for transcript editing, search, export, summaries, action items, vocabulary hints, confidence review, and meeting-platform ingestion. These are product gaps, not prerequisites for the requested transcription core.

## Provider decision record

| Candidate | Evidence | Decision |
|---|---|---|
| Gemini 3.5 Flash full-audio transcription | Google's current transcript sample uses Gemini 3.5 Flash and documents `audio_timestamp`: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/samples/googlegenaisdk-textgen-transcript-with-gcs-audio | Use the full Flash model for all accuracy-critical paths. Flash-Lite was removed after observed quality was insufficient for this workload. |
| Gemini live chunks | Lite models and independent four-second calls produced poor low-resource-language context and boundary loss. | Use Gemini 3.5 Flash with eight-second windows and one-second overlap for provisional display. Re-run the complete retained WAV at stop for the authoritative result. |
| Google Cloud Speech-to-Text Chirp 3 | Chirp 3 supports streaming, automatic language detection, and diarization, but language-agnostic mode documents the *prevalent* language and its diarization list does not include Sinhala or Tamil: https://docs.cloud.google.com/speech-to-text/v2/docs/chirp-model | Do not switch. It does not currently establish the requested three-language, per-utterance code-switching plus diarization behavior. |
| Cloud STT earlier models | Google's current matrix lists Sinhala `si-LK` on Chirp/Chirp 2 and Tamil on several variants, showing uneven feature coverage: https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages | Useful as a monolingual fallback to benchmark, not as the single orchestrator. |
| pyannote Community-1 | Community-1 supports an exclusive single-speaker timeline designed to simplify STT reconciliation: https://huggingface.co/pyannote/speaker-diarization-community-1 | Keep and use `exclusive_speaker_diarization`. It runs locally and is independent of transcript language. |
| OpenAI transcription | GPT-4o Transcribe Diarize provides built-in speaker segments, and GPT-Realtime-Whisper provides low-latency deltas: https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize and https://developers.openai.com/api/docs/models/gpt-realtime-whisper | Strong benchmark candidates. Do not migrate without a labeled Sinhala/Tamil/code-switch test set; the official pages do not establish comparative accuracy for this workload. |

Model IDs remain configuration, not hard-coded policy. A provider change should pass the evaluation gate below rather than rely on generic leaderboard claims.

## Implemented reliability changes

- Strict modes discard separately spoken content in the other two languages; Mixed accepts all three and adds per-utterance language labels.
- Script-based post-validation prevents obvious cross-script leakage and deterministically fills mixed-mode language labels.
- Gemini audio timestamp understanding is explicitly enabled.
- Silent PCM/WAV is rejected locally before transcription. Empty generated segments are removed; timelines are sorted, validated, and bounded to known audio duration so generated speech cannot extend past the recording.
- Community-1's exclusive timeline is preferred for speaker alignment.
- Uploads have size and extension limits; live sessions have a duration cap.
- Live finalization falls back to provisional chunks if the quality pass fails. Gemini speaker labels remain usable if optional local diarization cannot safely load or execute; unsafe checkpoint deserialization is never enabled.
- In-process background jobs are strongly referenced; JSON history writes are atomic; deleting history removes its audio.

## Production gaps

Before exposing the service to multiple users, add:

1. Authentication, per-user authorization, encryption at rest, retention controls, consent notices, and audit logs. The current privacy sentence in the UI is not a substitute for these controls.
2. Durable object storage, a transactional database, and a real job queue. In-process tasks and one JSON file are appropriate for a single-instance prototype only.
3. GCS-based long-audio processing. Inline full-session processing is size-limited; longer live sessions currently keep chunk previews and report a warning.
4. Rate limits, quotas, cancellation, retry/backoff with idempotency, structured logging, metrics, tracing, and health checks that verify dependencies—not only the web process.
5. Manual speaker rename and optional consented voice enrollment if “identify” must mean a person's name rather than anonymous voice separation.
6. Transcript correction, search, export (TXT/SRT/VTT/DOCX), vocabulary hints, confidence/uncertain-span review, and accessibility testing.
7. Replace the deprecated browser `ScriptProcessorNode` capture path with AudioWorklet for public-scale web use.
8. Replace the Meeting POC's in-process room registry and host secret with authenticated users, durable meeting state, expiring invitations, worker supervision, quotas, and abandoned-room cleanup.

## Evaluation gate

Build a consented, human-labeled test set split by mode and acoustic condition. At minimum include clean/noisy/far-field audio, overlapping speech, two to six speakers, Sri Lankan accents, names and numbers, silence/music, and:

- Sinhala-only, Tamil-only, and English-only files;
- Sinhala-English, Tamil-English, Sinhala-Tamil, and all-three code-switching;
- language changes inside a speaker turn and speaker changes inside a language run;
- short live utterances that cross the configured chunk boundary;
- long uploads and disconnect/retry cases.

Track word or character error rate per language, code-switch boundary accuracy, diarization error rate, speaker-attributed word error rate, hallucinated-speech rate on silence, p50/p95 preview latency, finalization latency, failure rate, and cost per audio hour. A replacement model must improve the weighted target metrics without regressing either Sinhala or Tamil beyond the agreed tolerance.

## Verification matrix

Automated tests cover timestamp validation, language script classification/filtering, mixed labels, silence RMS, PCM/WAV framing, speaker-overlap assignment, diarization failure fallback, full-session live replacement, and upload limits. Frontend checks cover TypeScript and the production web export. Provider-backed accuracy still requires the labeled audio evaluation set above; mocked unit tests cannot prove recognition quality.
