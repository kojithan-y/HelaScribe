import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  View,
  useColorScheme,
  useWindowDimensions,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import * as DocumentPicker from "expo-document-picker";
import * as Clipboard from "expo-clipboard";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  AudioModule,
  setAudioModeAsync,
  useAudioStream,
} from "expo-audio";
import { Feather, Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
  useFonts,
} from "@expo-google-fonts/dm-sans";

import { cancelTranscription, createMeeting, deleteTranscript, endMeeting, generateTranscriptSummary, getHistory, joinMeeting, renameTranscriptSpeaker, retryTranscription, submitAudio, translateTranscript, updateTranscript, WS_URL } from "./api";
import type { Language, MeetingConnection, ProcessingStage, Segment, SessionType, TranscriptRecord, TranscriptSummary } from "./types";
import type { MeetingClient, MeetingParticipantView } from "./livekitMeeting";
import { startWebAudioStream, type WebAudioStream } from "./webAudioStream";
import { useHistoryEvents } from "./hooks/useHistoryEvents";

const SESSION_TYPES: Array<{
  value: SessionType;
  label: string;
  hint: string;
  icon: keyof typeof Feather.glyphMap;
}> = [
  { value: "Record", label: "Record", hint: "Capture a session", icon: "mic" },
  { value: "Live", label: "Live", hint: "Transcribe as you speak", icon: "radio" },
  { value: "Upload", label: "Upload", hint: "Choose an audio file", icon: "upload-cloud" },
];

const waveform = [
  16, 24, 35, 22, 45, 30, 54, 38, 25, 48, 60, 34, 52,
  28, 43, 20, 32, 56, 39, 24, 49, 31, 18, 36, 58, 42,
  27, 51, 33, 63, 40, 23, 47, 29, 54, 35, 21, 39, 17,
];

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function speakerColor(speaker?: string | null) {
  if (!speaker) return "#B9B7C6";
  const numericLabel = speaker.match(/\d+/)?.[0];
  const number = numericLabel
    ? Number(numericLabel)
    : [...speaker].reduce((hash, character) => hash + character.charCodeAt(0), 0);
  return ["#A78BFA", "#34D399", "#60A5FA", "#FB7185"][number % 4] ?? "#A78BFA";
}

const PROCESSING_LABELS: Record<ProcessingStage, string> = {
  recording: "Recording",
  saving_audio: "Saving audio",
  transcribing: "Transcribing",
  diarizing: "Identifying speakers",
};

const LIVE_CONNECTION_TIMEOUT_MS = 12_000;

function recordStatusLabel(record: Pick<TranscriptRecord, "status" | "processing_stage">) {
  if (record.status === "processing" && record.processing_stage) {
    return PROCESSING_LABELS[record.processing_stage];
  }
  if (record.status === "queued") return "Queued";
  if (record.status === "completed") return "Completed";
  if (record.status === "failed") return "Failed";
  return "Processing";
}

function mergeTranscriptRecords(current: TranscriptRecord[], updates: TranscriptRecord[]) {
  const records = new Map(current.map((record) => [record.id, record]));
  updates.forEach((record) => records.set(record.id, record));
  return [...records.values()].sort(
    (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
  );
}

function transcriptText(record: TranscriptRecord) {
  const savedTranscript = record.transcript.trim();
  if (savedTranscript) return savedTranscript;
  return record.segments
    .map((segment) => `${segment.speaker ? `${segment.speaker}: ` : ""}${segment.text}`)
    .join("\n")
    .trim();
}

function summaryText(summary: TranscriptSummary) {
  const point = (item: { text: string; start_seconds?: number | null }) =>
    `${item.start_seconds == null ? "" : `[${formatTime(item.start_seconds)}] `}${item.text}`;
  const sections: string[] = [`OVERVIEW\n${summary.overview}`];
  if (summary.key_points.length) sections.push(`KEY POINTS\n${summary.key_points.map((item) => `• ${point(item)}`).join("\n")}`);
  if (summary.decisions.length) sections.push(`DECISIONS\n${summary.decisions.map((item) => `• ${point(item)}`).join("\n")}`);
  if (summary.action_items.length) sections.push(`ACTION ITEMS\n${summary.action_items.map((item) => {
    const details = [item.assignee && `Owner: ${item.assignee}`, item.due_date && `Due: ${item.due_date}`].filter(Boolean);
    return `• ${point(item)}${details.length ? ` (${details.join(" · ")})` : ""}`;
  }).join("\n")}`);
  if (summary.follow_ups.length) sections.push(`FOLLOW-UPS\n${summary.follow_ups.map((item) => `• ${point(item)}`).join("\n")}`);
  return sections.join("\n\n");
}

function exportFilename(record: TranscriptRecord, extension: string) {
  const created = new Date(record.created_at);
  const timestamp = Number.isNaN(created.getTime())
    ? record.id.slice(0, 8)
    : created.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `helascribe_${timestamp}.${extension.replace(/^\./, "")}`;
}

function downloadWebFile(contents: Blob, filename: string) {
  const url = URL.createObjectURL(contents);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type AppStyles = ReturnType<typeof createStyles>;

function SectionTitle({ number, title, styles }: { number: string; title: string; styles: AppStyles }) {
  return (
    <View style={styles.sectionTitle}>
      <View style={styles.numberBadge}><Text style={styles.numberText}>{number}</Text></View>
      <Text style={styles.sectionHeading}>{title}</Text>
    </View>
  );
}

function TypewriterText({ text, style }: { text: string; style: StyleProp<TextStyle> }) {
  const [count, setCount] = useState(0);
  const [cursorOn, setCursorOn] = useState(true);

  useEffect(() => {
    const typeTimer = setInterval(() => {
      setCount((current) => (current >= text.length ? current : current + 1));
    }, 45);
    const loopTimer = setInterval(() => setCount(0), 5000);
    return () => {
      clearInterval(typeTimer);
      clearInterval(loopTimer);
    };
  }, [text]);

  useEffect(() => {
    const blinkTimer = setInterval(() => setCursorOn((value) => !value), 500);
    return () => clearInterval(blinkTimer);
  }, []);

  return (
    <Text style={style}>
      {text.slice(0, count)}
      <Text style={{ opacity: count < text.length || cursorOn ? 1 : 0 }}>|</Text>
    </Text>
  );
}

function AnimatedWaveform({ active, intensity, styles }: { active: boolean; intensity: number; styles: AppStyles }) {
  const levels = useRef(waveform.map(() => new Animated.Value(0.08))).current;
  const audioState = useRef({ active, intensity });

  useEffect(() => {
    audioState.current = { active, intensity };
  }, [active, intensity]);

  useEffect(() => {
    let phase = 0;
    let animation: Animated.CompositeAnimation | null = null;
    const animate = () => {
      phase += 0.48;
      const state = audioState.current;
      // Boost only the visual response for quiet voices. This does not alter
      // microphone gain or the audio sent to the transcription backend.
      const energy = state.active
        ? Math.max(0.22, Math.min(1, Math.sqrt(Math.max(0, state.intensity)) * 1.35))
        : 0;
      animation = Animated.parallel(levels.map((level, index) => {
        const motion = 0.45 + 0.55 * Math.abs(Math.sin(phase + index * 0.58));
        const profile = 0.55 + (waveform[index]! / 73) * 0.45;
        const target = state.active
          ? Math.min(1, 0.12 + energy * motion * profile)
          : 0.04 + motion * profile * 0.075;
        return Animated.timing(level, {
          toValue: target,
          duration: state.active ? 135 : 360,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: false,
        });
      }));
      animation.start();
    };
    animate();
    const timer = setInterval(animate, active ? 145 : 380);
    return () => {
      clearInterval(timer);
      animation?.stop();
    };
  }, [active, levels]);

  return (
    <View style={styles.waveform} accessibilityLabel={active ? "Audio waveform active" : "Audio waveform idle"}>
      {waveform.map((height, index) => (
        <Animated.View
          key={index}
          style={[
            styles.waveBar,
            {
              height: levels[index]!.interpolate({ inputRange: [0, 1], outputRange: [5, height] }),
              opacity: active ? 0.95 : 0.28,
            },
          ]}
        />
      ))}
    </View>
  );
}

function SummaryPanel({
  record,
  summarizing,
  copied,
  exportBusy,
  onGenerate,
  onCopy,
  onSave,
  styles,
}: {
  record: TranscriptRecord;
  summarizing: boolean;
  copied: boolean;
  exportBusy: boolean;
  onGenerate?: (record: TranscriptRecord) => void;
  onCopy?: (summary: TranscriptSummary) => void;
  onSave?: (record: TranscriptRecord) => void;
  styles: AppStyles;
}) {
  const summary = record.summary;
  if (!summary) {
    return (
      <View style={styles.summaryEmptyCard}>
        <View style={styles.summaryIcon}><Feather name="zap" size={17} color="#B9A7FF" /></View>
        <View style={styles.summaryEmptyBody}>
          <Text style={styles.summaryTitle}>Smart summary</Text>
          <Text style={styles.summaryHint}>Create grounded key points, decisions, action items and follow-ups.</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Generate smart summary"
          disabled={summarizing}
          onPress={() => onGenerate?.(record)}
          style={[styles.summaryGenerateButton, summarizing && styles.exportButtonDisabled]}
        >
          {summarizing ? <ActivityIndicator color="white" size={13} /> : <Feather name="star" size={13} color="white" />}
          <Text style={styles.summaryGenerateText}>{summarizing ? "Generating…" : "Generate"}</Text>
        </Pressable>
      </View>
    );
  }

  const sections = [
    { title: "Key points", items: summary.key_points },
    { title: "Decisions", items: summary.decisions },
    { title: "Follow-ups", items: summary.follow_ups },
  ].filter((section) => section.items.length > 0);
  return (
    <View style={styles.summaryCard}>
      <View style={styles.summaryHeader}>
        <View style={styles.summaryHeadingRow}><Feather name="zap" size={15} color="#B9A7FF" /><Text style={styles.summaryTitle}>Smart summary</Text></View>
        <View style={styles.summaryMiniActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Copy summary" disabled={exportBusy} onPress={() => onCopy?.(summary)} style={styles.summaryMiniButton}>
            <Feather name={copied ? "check" : "copy"} size={13} color={copied ? "#34B981" : "#B9A7FF"} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Save summary as text file" disabled={exportBusy} onPress={() => onSave?.(record)} style={styles.summaryMiniButton}>
            {exportBusy ? <ActivityIndicator color="#B9A7FF" size={12} /> : <Feather name="download" size={13} color="#B9A7FF" />}
          </Pressable>
        </View>
      </View>
      <Text style={styles.summaryOverview}>{summary.overview}</Text>
      {sections.map((section) => (
        <View key={section.title} style={styles.summarySection}>
          <Text style={styles.summarySectionTitle}>{section.title}</Text>
          {section.items.map((item, index) => (
            <View key={`${section.title}-${index}`} style={styles.summaryPointRow}>
              <View style={styles.summaryBullet} />
              <Text style={styles.summaryPointText}>{item.start_seconds == null ? "" : `[${formatTime(item.start_seconds)}] `}{item.text}</Text>
            </View>
          ))}
        </View>
      ))}
      {summary.action_items.length ? (
        <View style={styles.summarySection}>
          <Text style={styles.summarySectionTitle}>Action items</Text>
          {summary.action_items.map((item, index) => (
            <View key={`action-${index}`} style={styles.summaryActionItem}>
              <View style={styles.summaryPointRow}><Feather name="check-square" size={12} color="#9F7AEA" /><Text style={styles.summaryPointText}>{item.start_seconds == null ? "" : `[${formatTime(item.start_seconds)}] `}{item.text}</Text></View>
              {item.assignee || item.due_date ? <Text style={styles.summaryActionMeta}>{item.assignee ? `Owner: ${item.assignee}` : ""}{item.assignee && item.due_date ? "  ·  " : ""}{item.due_date ? `Due: ${item.due_date}` : ""}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function TranscriptPanel({
  segments,
  active,
  status,
  processingStage,
  duration,
  intensity = 0,
  exportRecord,
  copied,
  exportBusy,
  onCopy,
  onSaveTranscript,
  summarizing,
  summaryCopied,
  onGenerateSummary,
  onCopySummary,
  onSaveSummary,
  onUpdateRecord,
  onRenameSpeaker,
  styles,
}: {
  segments: Segment[];
  active: boolean;
  status: string;
  processingStage?: ProcessingStage | null;
  duration: number;
  intensity?: number;
  exportRecord?: TranscriptRecord | null;
  copied?: boolean;
  exportBusy?: "transcript" | "summary" | null;
  onCopy?: (record: TranscriptRecord) => void;
  onSaveTranscript?: (record: TranscriptRecord) => void;
  summarizing?: boolean;
  summaryCopied?: boolean;
  onGenerateSummary?: (record: TranscriptRecord) => void;
  onCopySummary?: (summary: TranscriptSummary) => void;
  onSaveSummary?: (record: TranscriptRecord) => void;
  onUpdateRecord?: (record: TranscriptRecord, segments: Segment[]) => void;
  onRenameSpeaker?: (record: TranscriptRecord, oldName: string, newName: string) => void;
  onTranslate?: (record: TranscriptRecord, target: Language) => void;
  translating?: boolean;
  styles: AppStyles;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const isProcessing = !active && (status === "queued" || status === "processing" || Boolean(processingStage));
  const processingTitle = processingStage ? PROCESSING_LABELS[processingStage] : "Processing transcript";
  const processingCopy = processingStage === "diarizing"
    ? "The transcript is ready. Speaker labels are being refined in the background."
    : processingStage === "saving_audio"
      ? "Your recording is safe. Preparing it for transcription now."
      : "Your final transcript is being prepared in the background.";
  const badgeLabel = active ? "LIVE" : isProcessing ? processingTitle : status;
  return (
    <View style={styles.transcriptCard}>
      <View style={styles.transcriptHeader}>
        <View>
          <Text style={styles.panelEyebrow}>TRANSCRIPT</Text>
          <Text style={styles.panelTitle}>{active ? "Listening now" : isProcessing ? processingTitle : "Your words appear here"}</Text>
        </View>
        <View style={[styles.liveBadge, !active && styles.idleBadge]}>
          <View style={[styles.liveDot, !active && styles.idleDot]} />
          <Text style={[styles.liveText, !active && styles.idleText]}>{badgeLabel.toUpperCase()}</Text>
        </View>
      </View>

      <AnimatedWaveform active={active} intensity={intensity} styles={styles} />
      <View style={styles.timelineRow}>
        <Text style={styles.timeText}>{formatTime(duration)}</Text>
        <View style={styles.timeline} />
        <Text style={styles.timeText}>{active ? "REC" : "READY"}</Text>
      </View>

      {exportRecord && exportRecord.status === "completed" && transcriptText(exportRecord) ? (
        <View style={styles.exportActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy transcript"
            disabled={Boolean(exportBusy)}
            onPress={() => onCopy?.(exportRecord)}
            style={({ pressed }) => [styles.exportButton, copied && styles.exportButtonSuccess, pressed && styles.exportButtonPressed]}
          >
            <Feather name={copied ? "check" : "copy"} size={14} color={copied ? "#34B981" : "#B9A7FF"} />
            <Text style={[styles.exportButtonText, copied && styles.exportButtonSuccessText]}>{copied ? "Copied" : "Quick copy"}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save transcript as text file"
            disabled={Boolean(exportBusy)}
            onPress={() => onSaveTranscript?.(exportRecord)}
            style={({ pressed }) => [styles.exportButton, pressed && styles.exportButtonPressed, exportBusy && styles.exportButtonDisabled]}
          >
            {exportBusy === "transcript" ? <ActivityIndicator color="#B9A7FF" size={13} /> : <Feather name="file-text" size={14} color="#B9A7FF" />}
            <Text style={styles.exportButtonText}>Save TXT</Text>
          </Pressable>
        </View>
      ) : null}

      {isProcessing ? (
        <View style={styles.processingCard}>
          <ActivityIndicator color="#9F7AEA" size="small" />
          <View style={styles.processingBody}>
            <Text style={styles.processingTitle}>{processingTitle}</Text>
            <Text style={styles.processingCopy}>{processingCopy} You can start another recording.</Text>
          </View>
        </View>
      ) : null}

      <ScrollView style={styles.transcriptScroll} contentContainerStyle={styles.transcriptContent}>
        {exportRecord?.status === "completed" && transcriptText(exportRecord) ? (
          <SummaryPanel record={exportRecord} summarizing={Boolean(summarizing)} copied={Boolean(summaryCopied)} exportBusy={exportBusy === "summary"} onGenerate={onGenerateSummary} onCopy={onCopySummary} onSave={onSaveSummary} styles={styles} />
        ) : null}
        {segments.length === 0 ? (
          <View style={styles.emptyTranscript}>
            <View style={styles.emptyIcon}><MaterialCommunityIcons name={isProcessing ? "text-box-outline" : active ? "microphone-outline" : "waveform"} size={26} color="#8F8A9E" /></View>
            <Text style={styles.emptyTitle}>{isProcessing ? "Transcript on the way" : active && status === "recording" ? "Recording in progress" : active ? "Listening for speech" : "Ready when you are"}</Text>
            <Text style={styles.emptyCopy}>{isProcessing ? "Your final text will appear here automatically." : active && status === "recording" ? "Keep speaking. Your words will appear here as they are recognized." : active ? "Speak naturally and your live transcript will appear here." : "Choose your language and session type, then start a session."}</Text>
          </View>
        ) : segments.map((segment, index) => (
          <Pressable
            key={`${segment.start}-${index}`}
            onLongPress={() => {
              if (!exportRecord || !onUpdateRecord) return;
              setEditingIndex(index);
              setEditText(segment.text);
            }}
            style={[styles.segmentRow, segment.uncertain && styles.segmentUncertain]}
          >
            <Text style={styles.segmentTime}>{formatTime(segment.start)}</Text>
            <View style={[styles.speakerLine, { backgroundColor: speakerColor(segment.speaker) }]} />
            <View style={styles.segmentBody}>
              {segment.speaker || segment.detected_language ? (
                <View style={styles.segmentMeta}>
                  {segment.speaker ? (
                    <Pressable onLongPress={() => {
                      if (!exportRecord || !onRenameSpeaker) return;
                      if (Platform.OS === "web") {
                        const next = window.prompt("Rename speaker", segment.speaker ?? "");
                        if (next?.trim()) onRenameSpeaker(exportRecord, segment.speaker!, next.trim());
                      } else {
                        Alert.prompt?.("Rename speaker", "Enter a new speaker name", (next) => {
                          if (next?.trim()) onRenameSpeaker(exportRecord, segment.speaker!, next.trim());
                        }, "plain-text", segment.speaker ?? undefined);
                      }
                    }}>
                      <Text style={[styles.speakerName, { color: speakerColor(segment.speaker) }]}>{segment.speaker}</Text>
                    </Pressable>
                  ) : null}
                  {segment.detected_language ? <Text style={styles.languageTag}>{segment.detected_language}</Text> : null}
                  {segment.uncertain ? <Text style={styles.uncertainTag}>CHECK</Text> : null}
                </View>
              ) : null}
              {editingIndex === index ? (
                <View style={styles.segmentEditRow}>
                  <TextInput value={editText} onChangeText={setEditText} multiline autoFocus style={styles.segmentEditInput} />
                  <Pressable onPress={() => {
                    if (!exportRecord || !onUpdateRecord || !editText.trim()) return;
                    const updated = segments.map((item, itemIndex) => itemIndex === index ? { ...item, text: editText.trim(), uncertain: false } : item);
                    onUpdateRecord(exportRecord, updated);
                    setEditingIndex(null);
                  }} style={styles.segmentEditSave}><Feather name="check" size={14} color="white" /></Pressable>
                </View>
              ) : segment.translated_text ? (
                <>
                  <Text style={styles.segmentText}>{segment.translated_text}</Text>
                  <Text style={styles.sourceText}>{segment.text}</Text>
                </>
              ) : <Text style={styles.segmentText}>{segment.text}</Text>}
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
  });
  const { width, height } = useWindowDimensions();
  const systemScheme = useColorScheme();
  const [isDark, setIsDark] = useState(systemScheme !== "light");
  const styles = useMemo(() => createStyles(isDark, width), [isDark, width]);
  const isWide = width >= 900;
  const [tab, setTab] = useState<"new" | "history">("new");
  const [language] = useState<Language>("Mixed");
  const [sessionType, setSessionType] = useState<SessionType>("Live");
  const [diarization] = useState(false);
  const [hoveredSidebarItem, setHoveredSidebarItem] = useState<SessionType | null>(null);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState("ready");
  const [processingStage, setProcessingStage] = useState<ProcessingStage | null>(null);
  const [duration, setDuration] = useState(0);
  const [voiceIntensity, setVoiceIntensity] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [history, setHistory] = useState<TranscriptRecord[]>([]);
  const [selected, setSelected] = useState<TranscriptRecord | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<TranscriptRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingRecordId, setDeletingRecordId] = useState<string | null>(null);
  const [copiedRecordId, setCopiedRecordId] = useState<string | null>(null);
  const [copiedSummaryRecordId, setCopiedSummaryRecordId] = useState<string | null>(null);
  const [summarizingRecordId, setSummarizingRecordId] = useState<string | null>(null);
  const [translatingRecordId, setTranslatingRecordId] = useState<string | null>(null);
  const [jobActionId, setJobActionId] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [historyLanguage, setHistoryLanguage] = useState<Language | "All">("All");
  const [exporting, setExporting] = useState<{ id: string; kind: "transcript" | "summary" } | null>(null);
  const [trackedJobIds, setTrackedJobIds] = useState<string[]>([]);
  const [currentRecordId, setCurrentRecordId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [meetingName, setMeetingName] = useState("");
  const [meetingCode, setMeetingCode] = useState("");
  const [meetingConnection, setMeetingConnection] = useState<MeetingConnection | null>(null);
  const [meetingParticipants, setMeetingParticipants] = useState<MeetingParticipantView[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const webAudioRef = useRef<WebAudioStream | null>(null);
  const meetingClientRef = useRef<MeetingClient | null>(null);
  const historyScrollRef = useRef<ScrollView>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentRecordIdRef = useRef<string | null>(null);
  const activeRef = useRef(false);

  useEffect(() => { currentRecordIdRef.current = currentRecordId; }, [currentRecordId]);
  useEffect(() => { activeRef.current = active; }, [active]);

  const onAudioBuffer = useCallback((buffer: { data: ArrayBuffer }) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(buffer.data);
    const samples = new Int16Array(buffer.data);
    let sumSquares = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]! / 32768;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
    setVoiceIntensity((current) => current * 0.35 + Math.min(1, rms * 5) * 0.65);
  }, []);
  const liveAudio = useAudioStream({ sampleRate: 16000, channels: 1, encoding: "int16", onBuffer: onAudioBuffer });

  const stopAudioCapture = useCallback(async () => {
    if (Platform.OS === "web") {
      const capture = webAudioRef.current;
      webAudioRef.current = null;
      await capture?.stop();
      return;
    }
    liveAudio.stream?.stop();
  }, [liveAudio.stream]);

  useEffect(() => () => {
    socketRef.current?.close();
    void stopAudioCapture();
    void meetingClientRef.current?.disconnect();
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, [stopAudioCapture]);

  useEffect(() => {
    if (!active) return;
    const started = Date.now() - duration * 1000;
    const timer = setInterval(() => setDuration((Date.now() - started) / 1000), 250);
    return () => clearInterval(timer);
  }, [active]);

  const refreshHistory = useCallback(async () => {
    try {
      const records = await getHistory();
      setHistory(records);
      setSelected((current) => records.find((record) => record.id === current?.id) ?? current);
      const unfinished = records
        .filter((record) => record.status === "queued" || record.status === "processing")
        .map((record) => record.id);
      setTrackedJobIds((current) => [...new Set([...current, ...unfinished])]);
    } catch { /* backend may not be running yet */ }
  }, []);

  const trackJob = useCallback((id: string) => {
    setTrackedJobIds((current) => current.includes(id) ? current : [...current, id]);
  }, []);

  const applyRecordUpdate = useCallback((record: TranscriptRecord) => {
    setHistory((current) => mergeTranscriptRecords(current, [record]));
    setSelected((current) => current?.id === record.id ? record : current);
    if (currentRecordIdRef.current === record.id && !activeRef.current) {
      setStatus(record.status);
      setProcessingStage(record.processing_stage ?? null);
      setDuration((current) => record.duration_seconds ?? current);
      setSegments(record.segments);
    }
    if (record.status === "completed" || record.status === "failed") {
      setTrackedJobIds((current) => current.filter((id) => id !== record.id));
    }
  }, []);

  const confirmDelete = (record: TranscriptRecord) => {
    setDeleteError(null);
    setDeleteCandidate(record);
  };

  const performDelete = async () => {
    const record = deleteCandidate;
    if (!record || deletingRecordId) return;
    setDeleteError(null);
    setDeletingRecordId(record.id);
    try {
      await deleteTranscript(record.id);
      setHistory((current) => current.filter((item) => item.id !== record.id));
      setSelected((current) => current?.id === record.id ? null : current);
      setTrackedJobIds((current) => current.filter((id) => id !== record.id));
      if (currentRecordId === record.id) {
        setCurrentRecordId(null);
        setSegments([]);
      }
      setDeleteCandidate(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete transcript");
    } finally {
      setDeletingRecordId(null);
    }
  };

  const copyTranscript = async (record: TranscriptRecord) => {
    try {
      const copiedSuccessfully = await Clipboard.setStringAsync(transcriptText(record));
      if (!copiedSuccessfully) throw new Error("Clipboard access was not available");
      setCopiedSummaryRecordId(null);
      setCopiedRecordId(record.id);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedRecordId(null), 2000);
    } catch (error) {
      Alert.alert("Could not copy", error instanceof Error ? error.message : "Clipboard access failed");
    }
  };

  const copySummary = async (recordId: string, summary: TranscriptSummary) => {
    try {
      const copiedSuccessfully = await Clipboard.setStringAsync(summaryText(summary));
      if (!copiedSuccessfully) throw new Error("Clipboard access was not available");
      setCopiedRecordId(null);
      setCopiedSummaryRecordId(recordId);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopiedSummaryRecordId(null), 2000);
    } catch (error) {
      Alert.alert("Could not copy summary", error instanceof Error ? error.message : "Clipboard access failed");
    }
  };

  const generateSummary = async (record: TranscriptRecord) => {
    if (summarizingRecordId) return;
    setSummarizingRecordId(record.id);
    try {
      const summary = await generateTranscriptSummary(record.id);
      setHistory((current) => current.map((item) => item.id === record.id ? { ...item, summary } : item));
      setSelected((current) => current?.id === record.id ? { ...current, summary } : current);
    } catch (error) {
      Alert.alert("Could not generate summary", error instanceof Error ? error.message : "Summary generation failed");
    } finally {
      setSummarizingRecordId(null);
    }
  };

  const editTranscriptSegments = async (record: TranscriptRecord, nextSegments: Segment[]) => {
    try {
      applyRecordUpdate(await updateTranscript(record.id, { segments: nextSegments }));
    } catch (error) {
      Alert.alert("Could not save edit", error instanceof Error ? error.message : "Transcript update failed");
    }
  };

  const translateRecord = async (record: TranscriptRecord, target: Language) => {
    if (target === "Mixed" || translatingRecordId) return;
    setTranslatingRecordId(record.id);
    try {
      applyRecordUpdate(await translateTranscript(record.id, target));
    } catch (error) {
      Alert.alert("Could not translate", error instanceof Error ? error.message : "Translation failed");
    } finally {
      setTranslatingRecordId(null);
    }
  };

  const renameSpeaker = async (record: TranscriptRecord, oldName: string, newName: string) => {
    try {
      applyRecordUpdate(await renameTranscriptSpeaker(record.id, oldName, newName));
    } catch (error) {
      Alert.alert("Could not rename speaker", error instanceof Error ? error.message : "Speaker update failed");
    }
  };


  const runJobAction = async (record: TranscriptRecord, action: "cancel" | "retry") => {
    if (jobActionId) return;
    setJobActionId(record.id);
    try {
      await (action === "cancel" ? cancelTranscription(record.id) : retryTranscription(record.id));
      await refreshHistory();
    } catch (error) {
      Alert.alert(`Could not ${action}`, error instanceof Error ? error.message : "Job action failed");
    } finally {
      setJobActionId(null);
    }
  };

  const saveTranscript = async (record: TranscriptRecord) => {
    if (exporting) return;
    setExporting({ id: record.id, kind: "transcript" });
    try {
      const filename = exportFilename(record, "txt");
      const contents = transcriptText(record);
      if (Platform.OS === "web") {
        downloadWebFile(new Blob([contents], { type: "text/plain;charset=utf-8" }), filename);
      } else {
        const available = await Sharing.isAvailableAsync();
        if (!available) throw new Error("File sharing is not available on this device");
        const file = new File(Paths.cache, filename);
        file.create({ overwrite: true });
        file.write(contents);
        await Sharing.shareAsync(file.uri, {
          dialogTitle: "Save or share transcript",
          mimeType: "text/plain",
          UTI: "public.plain-text",
        });
      }
    } catch (error) {
      Alert.alert("Could not save transcript", error instanceof Error ? error.message : "Export failed");
    } finally {
      setExporting(null);
    }
  };

  const saveSummary = async (record: TranscriptRecord) => {
    if (exporting || !record.summary) return;
    setExporting({ id: record.id, kind: "summary" });
    try {
      const filename = exportFilename(record, "summary.txt");
      const contents = summaryText(record.summary);
      if (Platform.OS === "web") {
        downloadWebFile(new Blob([contents], { type: "text/plain;charset=utf-8" }), filename);
      } else {
        const available = await Sharing.isAvailableAsync();
        if (!available) throw new Error("File sharing is not available on this device");
        const file = new File(Paths.cache, filename);
        file.create({ overwrite: true });
        file.write(contents);
        await Sharing.shareAsync(file.uri, {
          dialogTitle: "Save or share summary",
          mimeType: "text/plain",
          UTI: "public.plain-text",
        });
      }
    } catch (error) {
      Alert.alert("Could not save summary", error instanceof Error ? error.message : "Export failed");
    } finally {
      setExporting(null);
    }
  };

  useEffect(() => { void refreshHistory(); }, [refreshHistory]);

  useEffect(() => {
    if (tab !== "history") return;
    const timer = setTimeout(() => historyScrollRef.current?.scrollTo({ y: 0, animated: false }), 50);
    return () => clearTimeout(timer);
  }, [selected?.id, tab]);

  const handleDeletedEvent = useCallback((id: string) => {
    setHistory((current) => current.filter((record) => record.id !== id));
    setSelected((current) => current?.id === id ? null : current);
  }, []);
  useHistoryEvents(applyRecordUpdate, handleDeletedEvent);

  const prepareMic = async () => {
    if (Platform.OS === "web") return;
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error("Microphone permission is required");
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
  };

  const startLive = async () => {
    await prepareMic();
    setCurrentRecordId(null);
    setProcessingStage(null);
    setSegments([]);
    setDuration(0);
    setVoiceIntensity(0);
    setStatus("connecting");
    setBusy(true);
    const socket = new WebSocket(WS_URL);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    const connectionTimer = setTimeout(() => {
      if (socketRef.current !== socket || socket.readyState === WebSocket.CLOSED) return;
      socketRef.current = null;
      socket.close();
      void stopAudioCapture();
      setActive(false);
      setBusy(false);
      setStatus("offline");
      Alert.alert("Connection timed out", `The backend did not respond at ${WS_URL}. Check that both devices are on the same network.`);
    }, LIVE_CONNECTION_TIMEOUT_MS);
    const clearConnectionTimer = () => clearTimeout(connectionTimer);
    socket.onopen = () => {
      socket.send(JSON.stringify({ language, session_type: sessionType, diarization, sample_rate: 16000, title: `${sessionType} • ${new Date().toLocaleString()}` }));
    };
    socket.onmessage = (event) => {
      void (async () => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "ready") {
            clearConnectionTimer();
            trackJob(message.id);
            setCurrentRecordId(message.id);
            setProcessingStage("recording");
            if (Platform.OS === "web") {
              webAudioRef.current = await startWebAudioStream((buffer, level) => {
                setVoiceIntensity((current) => current * 0.35 + level * 0.65);
                onAudioBuffer({ data: buffer });
              });
            } else {
              await liveAudio.stream.start();
            }
            setStatus("listening");
            setActive(true);
            setBusy(false);
          } else if (message.type === "transcript") {
            setStatus("listening");
            setSegments((current) => [...current, message.segment]);
          } else if (message.type === "translation") {
            setSegments((current) => current.map((segment) => (
              segment.start === message.segment.start
                && segment.end === message.segment.end
                && segment.text === message.segment.text
                ? { ...segment, translated_text: message.segment.translated_text }
                : segment
            )));
          } else if (message.type === "warning") {
            setStatus("listening - preview delayed");
            setBusy(false);
          } else if (message.type === "finalizing") {
            trackJob(message.id);
            if (socketRef.current === socket) socketRef.current = null;
            setStatus("stopped - finalizing in background");
            setProcessingStage("transcribing");
            setBusy(false);
          } else if (message.type === "error") {
            clearConnectionTimer();
            await stopAudioCapture();
            setActive(false);
            setBusy(false);
            Alert.alert("Live transcription", message.message);
          }
        } catch (error) {
          await stopAudioCapture();
          socket.close();
          setActive(false);
          setBusy(false);
          setStatus("error");
          Alert.alert("Live transcription", error instanceof Error ? error.message : "Could not start audio capture");
        }
      })();
    };
    socket.onerror = () => {
      clearConnectionTimer();
      if (socketRef.current !== socket) return;
      void stopAudioCapture();
      setActive(false);
      setBusy(false);
      setStatus("offline");
      Alert.alert("Connection failed", `Could not connect to ${WS_URL}`);
    };
    socket.onclose = () => {
      clearConnectionTimer();
      if (socketRef.current === socket) {
        socketRef.current = null;
        void stopAudioCapture();
        setActive(false);
      }
    };
  };

  const stopLive = async () => {
    await stopAudioCapture();
    socketRef.current?.send("stop");
    setActive(false);
    setBusy(true);
    setStatus("stopping");
  };

  const connectToMeeting = async (connection: MeetingConnection) => {
    setMeetingConnection(connection);
    setMeetingCode(connection.room_code);
    setCurrentRecordId(connection.meeting_id);
    setProcessingStage("recording");
    trackJob(connection.meeting_id);
    const { connectMeeting } = await import("helascribe-meeting-connector");
    const client = await connectMeeting(connection.livekit_url, connection.token, {
      onConnectionChange: setStatus,
      onParticipantsChange: setMeetingParticipants,
      onSegment: (segment) => setSegments((current) => {
        const duplicate = current.some((item) =>
          item.participant_identity === segment.participant_identity
          && item.start === segment.start
          && item.end === segment.end
          && item.text === segment.text
        );
        return duplicate ? current : [...current, segment].sort((a, b) => a.start - b.start);
      }),
      onError: (error) => Alert.alert("Meeting", error.message),
    });
    meetingClientRef.current = client;
    setActive(true);
    setBusy(false);
  };

  const startMeeting = async (join: boolean) => {
    const displayName = meetingName.trim();
    if (!displayName) throw new Error("Enter your display name");
    if (join && !meetingCode.trim()) throw new Error("Enter a room code");
    setBusy(true);
    setStatus(join ? "joining" : "creating");
    setCurrentRecordId(null);
    setProcessingStage(null);
    setSegments([]);
    setDuration(0);
      const connection = join
      ? await joinMeeting(meetingCode, displayName, diarization)
      : await createMeeting(displayName, "Mixed", diarization);
    try {
      await connectToMeeting(connection);
    } catch (error) {
      setMeetingConnection(null);
      setBusy(false);
      throw error;
    }
  };

  const stopMeeting = async () => {
    const connection = meetingConnection;
    if (!connection) return;
    setActive(false);
    setBusy(connection.is_host);
    setStatus(connection.is_host ? "finalizing meeting" : "left meeting");
    if (connection.is_host && connection.host_secret) {
      const result = await endMeeting(connection.room_code, connection.host_secret);
      trackJob(result.id);
      setProcessingStage("saving_audio");
    }
    await meetingClientRef.current?.disconnect();
    meetingClientRef.current = null;
    setMeetingParticipants([]);
    setMeetingConnection(null);
    setBusy(false);
  };

  const chooseUpload = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: "audio/*", copyToCacheDirectory: true });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    setBusy(true);
    setCurrentRecordId(null);
    setSegments([]);
    setProcessingStage(null);
    setStatus("uploading");
    try {
      const job = await submitAudio(asset.uri, asset.name, asset.mimeType ?? "audio/mpeg", language, "Upload", diarization, asset.file);
      trackJob(job.id);
      setCurrentRecordId(job.id);
      setStatus("processing");
      setProcessingStage("transcribing");
      setBusy(false);
    } catch (error) {
      setBusy(false);
      Alert.alert("Upload failed", error instanceof Error ? error.message : "Unknown error");
    }
  };

  const handlePrimary = async () => {
    try {
      if (sessionType === "Meeting") return active ? await stopMeeting() : await startMeeting(false);
      if (active) return sessionType === "Live" || sessionType === "Record" ? await stopLive() : await stopMeeting();
      if (sessionType === "Upload") return await chooseUpload();
      if (sessionType === "Live" || sessionType === "Record") return await startLive();
      return await startLive();
    } catch (error) {
      if (sessionType === "Live") {
        await stopAudioCapture();
        socketRef.current?.close();
        socketRef.current = null;
      }
      if (sessionType === "Meeting") {
        await meetingClientRef.current?.disconnect();
        meetingClientRef.current = null;
        setMeetingConnection(null);
      }
      setActive(false);
      setBusy(false);
      Alert.alert("Could not start", error instanceof Error ? error.message : "Unknown error");
    }
  };

  const primaryLabel = active
    ? sessionType === "Meeting" && !meetingConnection?.is_host ? "Leave meeting" : sessionType === "Meeting" ? "End meeting" : "Stop session"
    : sessionType === "Upload" ? "Choose audio file" : sessionType === "Live" ? "Start live transcription" : sessionType === "Meeting" ? "Create meeting" : "Start recording";
  const shownDuration = duration;
  const displayedSegments = selected?.segments ?? [];
  const currentExportRecord = history.find((record) => record.id === currentRecordId) ?? null;
  const filteredHistory = useMemo(() => {
    const needle = historySearch.trim().toLocaleLowerCase();
    return history.filter((record) => {
      if (historyLanguage !== "All" && record.language !== historyLanguage) return false;
      if (!needle) return true;
      return record.title.toLocaleLowerCase().includes(needle)
        || record.transcript.toLocaleLowerCase().includes(needle);
    });
  }, [history, historyLanguage, historySearch]);

  if (!fontsLoaded) return <View style={styles.loading}><ActivityIndicator color="#9F7AEA" /></View>;

  return (
    <View style={styles.appShell}>
      {isWide ? (
        <View style={styles.iconSidebar}>
          {SESSION_TYPES.map((item) => (
            <View key={item.value} style={styles.iconSidebarItemWrap}>
              <Pressable
                accessibilityRole="radio"
                accessibilityLabel={`${item.label}. ${item.hint}`}
                accessibilityState={{ checked: sessionType === item.value }}
                onHoverIn={() => setHoveredSidebarItem(item.value)}
                onHoverOut={() => setHoveredSidebarItem((current) => (current === item.value ? null : current))}
                onPress={() => { setSessionType(item.value); setTab("new"); setSelected(null); }}
                style={({ pressed }) => [
                  styles.iconSidebarButton,
                  sessionType === item.value && styles.iconSidebarButtonActive,
                  hoveredSidebarItem === item.value && { transform: [{ scale: 1.18 }] },
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Feather name={item.icon} size={19} color={sessionType === item.value ? "white" : "#9A95A8"} />
              </Pressable>
              {hoveredSidebarItem === item.value ? (
                <View style={styles.iconSidebarTooltip}>
                  <Text style={styles.iconSidebarTooltipText}>{item.label}</Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.app}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <View style={styles.glowOne} /><View style={styles.glowTwo} />
      <View style={styles.header}>
        <Pressable style={styles.brand} onPress={() => { setTab("new"); setSelected(null); }}>
          <LinearGradient colors={["#A78BFA", "#6D5CE7"]} style={styles.logo}>
            <MaterialCommunityIcons name="waveform" size={23} color="white" />
          </LinearGradient>
          <View><Text style={styles.brandName}>VoxLive</Text><Text style={styles.brandTagline}>VOICE TO TEXT, BEAUTIFULLY</Text></View>
        </Pressable>
        {isWide ? (
          <View style={styles.desktopNav}>
            <Pressable onPress={() => { setTab("new"); setSelected(null); }} style={[styles.navItem, tab === "new" && styles.navItemActive]}><Feather name="plus-circle" size={17} color={tab === "new" ? "#C4B5FD" : "#8F8A9E"} /><Text style={[styles.navText, tab === "new" && styles.navTextActive]}>New transcript</Text></Pressable>
            <Pressable onPress={() => { setTab("history"); void refreshHistory(); }} style={[styles.navItem, tab === "history" && styles.navItemActive]}><Feather name="clock" size={17} color={tab === "history" ? "#C4B5FD" : "#8F8A9E"} /><Text style={[styles.navText, tab === "history" && styles.navTextActive]}>History</Text></Pressable>
          </View>
        ) : null}
        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Switch to ${isDark ? "light" : "dark"} mode`}
            onPress={() => setIsDark((current) => !current)}
            style={({ pressed }) => [styles.themeButton, pressed && { opacity: 0.7 }]}
          >
            <Feather name={isDark ? "sun" : "moon"} size={17} color={isDark ? "#D8CDF8" : "#5C477A"} />
          </Pressable>
        </View>
      </View>

      {tab === "history" ? (
        <ScrollView key="history" ref={historyScrollRef} onContentSizeChange={() => historyScrollRef.current?.scrollTo({ y: 0, animated: false })} contentContainerStyle={styles.historyPage}>
          {!isWide && selected ? (
            <View style={styles.historyDetail}>
              <View style={styles.historyDetailActions}>
                <Pressable accessibilityRole="button" accessibilityLabel="Back to transcript history" onPress={() => setSelected(null)} style={styles.historyBackButton}>
                  <Feather name="arrow-left" size={17} color="#B9A7FF" />
                  <Text style={styles.historyBackText}>Back to history</Text>
                </Pressable>
                {selected.status === "completed" || selected.status === "failed" ? (
                  <Pressable accessibilityRole="button" accessibilityLabel="Delete transcript" disabled={deletingRecordId === selected.id} onPress={() => confirmDelete(selected)} style={styles.historyDeleteButton}>
                    {deletingRecordId === selected.id ? <ActivityIndicator color="#EF6A7F" size={15} /> : <Feather name="trash-2" size={16} color="#EF6A7F" />}
                  </Pressable>
                ) : null}
              </View>
              <Text numberOfLines={2} style={styles.historyDetailTitle}>{selected.title}</Text>
              <TranscriptPanel segments={displayedSegments} active={false} status={selected.status} processingStage={selected.processing_stage} duration={selected.duration_seconds ?? 0} exportRecord={selected} copied={copiedRecordId === selected.id} exportBusy={exporting?.id === selected.id ? exporting.kind : null} onCopy={(record) => void copyTranscript(record)} onSaveTranscript={(record) => void saveTranscript(record)} summarizing={summarizingRecordId === selected.id} summaryCopied={copiedSummaryRecordId === selected.id} onGenerateSummary={(record) => void generateSummary(record)} onCopySummary={(summary) => void copySummary(selected.id, summary)} onSaveSummary={(record) => void saveSummary(record)} onUpdateRecord={(record, next) => void editTranscriptSegments(record, next)} onRenameSpeaker={(record, oldName, newName) => void renameSpeaker(record, oldName, newName)} onTranslate={(record, target) => void translateRecord(record, target)} translating={translatingRecordId === selected.id} styles={styles} />
            </View>
          ) : (
            <View style={[styles.historyLayout, isWide && styles.historyLayoutWide]}>
              <View style={styles.historyList}>
                <View style={styles.historyFilters}>
                  <View style={styles.historyFilterHeader}>
                    <View><Text style={styles.historyFilterTitle}>Recordings</Text><Text style={styles.historyFilterCount}>{filteredHistory.length} of {history.length}</Text></View>
                    {historySearch || historyLanguage !== "All" ? <Pressable accessibilityRole="button" accessibilityLabel="Clear history filters" onPress={() => { setHistorySearch(""); setHistoryLanguage("All"); }} style={styles.historyClearButton}><Feather name="x" size={13} color="#B9A7FF" /><Text style={styles.historyClearText}>Clear</Text></Pressable> : null}
                  </View>
                  <View style={styles.historySearchBox}>
                    <View style={styles.historySearchIcon}><Feather name="search" size={16} color="#9F7AEA" /></View>
                    <TextInput accessibilityLabel="Search transcript history" value={historySearch} onChangeText={setHistorySearch} placeholder="Search title or spoken words..." placeholderTextColor="#777181" returnKeyType="search" underlineColorAndroid="transparent" cursorColor="#9F7AEA" selectionColor="rgba(159,122,234,0.32)" style={styles.historySearchInput} />
                    {historySearch ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8} onPress={() => setHistorySearch("")} style={styles.historySearchReset}><Feather name="x" size={14} color="#8F8A9E" /></Pressable> : null}
                  </View>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.historyFilterPills}>
                    {(["All", "Sinhala", "Tamil", "English", "Mixed"] as const).map((item) => <Pressable key={item} onPress={() => setHistoryLanguage(item)} style={[styles.historyFilterPill, historyLanguage === item && styles.historyFilterPillActive]}><Text style={[styles.historyFilterText, historyLanguage === item && styles.historyFilterTextActive]}>{item}</Text></Pressable>)}
                  </ScrollView>
                </View>
                <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={isWide} style={[styles.historyResultsScroll, isWide && { maxHeight: Math.max(460, height - 330) }]} contentContainerStyle={styles.historyResultsContent}>
                {filteredHistory.length === 0 ? <View style={styles.historyEmpty}><Feather name="search" size={22} color="#8F8A9E" /><Text style={styles.emptyTitle}>No recordings found</Text><Text style={styles.emptyCopy}>Try another title, phrase, or language.</Text></View> : filteredHistory.map((item) => (
                  <Pressable key={item.id} onPress={() => setSelected(item)} style={[styles.historyItem, selected?.id === item.id && styles.historyItemSelected]}>
                    <View style={styles.historyIcon}><Feather name={item.session_type === "Meeting" ? "users" : item.session_type === "Live" ? "radio" : item.session_type === "Upload" ? "upload-cloud" : "mic"} size={19} color="#B9A7FF" /></View>
                    <View style={styles.historyBody}>
                      <Text numberOfLines={1} style={styles.historyTitle}>{item.title}</Text>
                      <View style={styles.historyMetaRow}><Text numberOfLines={1} style={styles.historyMeta}>{item.language} · {new Date(item.created_at).toLocaleDateString()}</Text><View style={styles.historyDuration}><Feather name="clock" size={10} color="#8F8A9E" /><Text style={styles.historyDurationText}>{item.duration_seconds != null ? formatTime(item.duration_seconds) : "--:--"}</Text></View></View>
                    </View>
                    <View style={[styles.historyStatus, item.status === "completed" && styles.historyStatusCompleted, item.status === "failed" && styles.historyStatusFailed]}>
                      {item.status === "queued" || item.status === "processing" ? <ActivityIndicator color="#9F7AEA" size={10} /> : null}
                      <Text style={[styles.historyStatusText, item.status === "completed" && styles.historyStatusCompletedText, item.status === "failed" && styles.historyStatusFailedText]}>{recordStatusLabel(item)}</Text>
                    </View>
                    {(item.session_type === "Record" || item.session_type === "Upload") && (item.status === "queued" || item.status === "processing" || item.status === "failed") ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={item.status === "failed" ? `Retry ${item.title}` : `Cancel ${item.title}`}
                        disabled={jobActionId === item.id}
                        onPress={(event) => { event.stopPropagation(); void runJobAction(item, item.status === "failed" ? "retry" : "cancel"); }}
                        style={styles.historyRowDelete}
                      >
                        {jobActionId === item.id ? <ActivityIndicator color="#B9A7FF" size={14} /> : <Feather name={item.status === "failed" ? "refresh-cw" : "x"} size={15} color="#B9A7FF" />}
                      </Pressable>
                    ) : null}
                    {item.status === "completed" || item.status === "failed" ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${item.title}`}
                        disabled={deletingRecordId === item.id}
                        onPress={(event) => { event.stopPropagation(); confirmDelete(item); }}
                        hitSlop={8}
                        style={styles.historyRowDelete}
                      >
                        {deletingRecordId === item.id ? <ActivityIndicator color="#EF6A7F" size={14} /> : <Feather name="trash-2" size={15} color="#9A7180" />}
                      </Pressable>
                    ) : <Feather name="chevron-right" size={18} color="#625E70" />}
                  </Pressable>
                ))}
                </ScrollView>
              </View>
              {isWide ? <View style={[styles.historyTranscriptPane, { height: Math.max(620, height - 245) }]}><View style={styles.historyTranscriptHeading}><Text style={styles.historyTranscriptLabel}>SELECTED TRANSCRIPT</Text><Text numberOfLines={1} style={styles.historyTranscriptTitle}>{selected?.title ?? "Choose a recording"}</Text></View><TranscriptPanel segments={displayedSegments} active={false} status={selected?.status ?? "select one"} processingStage={selected?.processing_stage} duration={selected?.duration_seconds ?? 0} exportRecord={selected} copied={copiedRecordId === selected?.id} exportBusy={exporting?.id === selected?.id ? exporting?.kind ?? null : null} onCopy={(record) => void copyTranscript(record)} onSaveTranscript={(record) => void saveTranscript(record)} summarizing={summarizingRecordId === selected?.id} summaryCopied={copiedSummaryRecordId === selected?.id} onGenerateSummary={(record) => void generateSummary(record)} onCopySummary={(summary) => { if (selected) void copySummary(selected.id, summary); }} onSaveSummary={(record) => void saveSummary(record)} onUpdateRecord={(record, next) => void editTranscriptSegments(record, next)} onRenameSpeaker={(record, oldName, newName) => void renameSpeaker(record, oldName, newName)} onTranslate={(record, target) => void translateRecord(record, target)} translating={translatingRecordId === selected?.id} styles={styles} /></View> : null}
            </View>
          )}
        </ScrollView>
      ) : (
        <ScrollView key="new" contentContainerStyle={styles.mainScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.pageIntro}>
            <Text style={styles.eyebrow}>NEW TRANSCRIPTION</Text>
            <TypewriterText text="Turn every voice into words." style={styles.heroTitle} />
            <Text style={styles.heroCopy}>Fast, accurate transcription for Sinhala, Tamil and English.</Text>
          </View>
          <View style={[styles.workspace, isWide && styles.workspaceWide]}>
            <View style={styles.controlsColumn}>
              <View style={styles.controlSection}>
                <SectionTitle number="01" title="Automatic language detection" styles={styles} />
                <View style={styles.autoLanguageCard}>
                  <View style={styles.autoLanguageIcon}><Feather name="globe" size={19} color="#755BD0" /></View>
                  <View style={styles.autoLanguageBody}>
                    <Text style={styles.autoLanguageTitle}>Sinhala, Tamil and English</Text>
                    <Text style={styles.autoLanguageHint}>Detected automatically. Your translation is always prepared in Tamil.</Text>
                  </View>
                  <View style={styles.autoLanguageBadge}><Text style={styles.autoLanguageBadgeText}>AUTO</Text></View>
                </View>
              </View>

              <View style={styles.controlSection}>
                <SectionTitle number="02" title="How would you like to begin?" styles={styles} />
                <View style={[styles.sessionGrid, !isWide && width < 540 && styles.sessionGridStack]}>
                  {SESSION_TYPES.map((item) => (
                    <Pressable key={item.value} accessibilityRole="radio" accessibilityLabel={`${item.label}. ${item.hint}`} accessibilityState={{ checked: sessionType === item.value, disabled: active || busy }} disabled={active || busy} onPress={() => setSessionType(item.value)} style={({ pressed }) => [styles.sessionCard, sessionType === item.value && styles.sessionCardActive, (active || busy) && { opacity: 0.55 }, pressed && { opacity: 0.8 }]}>
                      <View style={[styles.sessionIcon, sessionType === item.value && styles.sessionIconActive]}><Feather name={item.icon} size={20} color={sessionType === item.value ? "white" : "#9A95A8"} /></View>
                      <Text style={[styles.sessionLabel, sessionType === item.value && styles.sessionLabelActive]}>{item.label}</Text>
                      <Text style={styles.sessionHint}>{item.hint}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <Pressable disabled={busy && !active} onPress={() => void handlePrimary()} style={({ pressed }) => [styles.primaryWrap, pressed && { opacity: 0.88 }, busy && !active && { opacity: 0.62 }]}>
                <LinearGradient colors={active ? ["#EF5C75", "#C93F65"] : ["#A98AF7", "#7258D9"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.primaryButton}>
                  {busy && !active ? <ActivityIndicator color="white" size="small" /> : <Feather name={active ? "square" : sessionType === "Upload" ? "upload-cloud" : "mic"} size={19} color="white" />}
                  <Text style={styles.primaryText}>{busy && !active ? status : active ? `${primaryLabel} · ${formatTime(shownDuration)}` : primaryLabel}</Text>
                </LinearGradient>
              </Pressable>
              <View style={styles.privacyRow}><Feather name="shield" size={13} color="#716C7F" /><Text style={styles.privacyText}>Your audio is encrypted in transit and never used to train public models.</Text></View>
            </View>

            <TranscriptPanel segments={segments} active={active} status={status} processingStage={processingStage} duration={shownDuration} intensity={voiceIntensity} exportRecord={currentExportRecord} copied={copiedRecordId === currentRecordId} exportBusy={exporting?.id === currentRecordId ? exporting.kind : null} onCopy={(record) => void copyTranscript(record)} onSaveTranscript={(record) => void saveTranscript(record)} summarizing={summarizingRecordId === currentRecordId} summaryCopied={copiedSummaryRecordId === currentRecordId} onGenerateSummary={(record) => void generateSummary(record)} onCopySummary={(summary) => { if (currentRecordId) void copySummary(currentRecordId, summary); }} onSaveSummary={(record) => void saveSummary(record)} onUpdateRecord={(record, next) => void editTranscriptSegments(record, next)} onRenameSpeaker={(record, oldName, newName) => void renameSpeaker(record, oldName, newName)} onTranslate={(record, target) => void translateRecord(record, target)} translating={translatingRecordId === currentRecordId} styles={styles} />
          </View>
        </ScrollView>
      )}

      <Modal
        transparent
        visible={deleteCandidate !== null}
        animationType="fade"
        onRequestClose={() => { if (!deletingRecordId) setDeleteCandidate(null); }}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel delete"
            disabled={deletingRecordId !== null}
            onPress={() => setDeleteCandidate(null)}
            style={StyleSheet.absoluteFill}
          />
          <View accessibilityRole="alert" style={styles.deleteDialog}>
            <View style={styles.deleteDialogIcon}><Feather name="trash-2" size={20} color="#EF6A7F" /></View>
            <Text style={styles.deleteDialogTitle}>Delete transcript?</Text>
            <Text style={styles.deleteDialogCopy}>“{deleteCandidate?.title}” and its saved audio will be permanently removed.</Text>
            {deleteError ? <Text style={styles.deleteDialogError}>{deleteError}</Text> : null}
            <View style={styles.deleteDialogActions}>
              <Pressable disabled={deletingRecordId !== null} onPress={() => setDeleteCandidate(null)} style={styles.deleteCancelButton}>
                <Text style={styles.deleteCancelText}>Cancel</Text>
              </Pressable>
              <Pressable disabled={deletingRecordId !== null} onPress={() => void performDelete()} style={styles.deleteConfirmButton}>
                {deletingRecordId ? <ActivityIndicator color="white" size={15} /> : <Feather name="trash-2" size={15} color="white" />}
                <Text style={styles.deleteConfirmText}>{deletingRecordId ? "Deleting…" : "Delete"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {!isWide ? (
        <View style={styles.mobileNav}>
          <Pressable onPress={() => { setTab("new"); setSelected(null); }} style={styles.mobileNavItem}><Ionicons name={tab === "new" ? "add-circle" : "add-circle-outline"} size={24} color={tab === "new" ? "#B9A7FF" : "#777181"} /><Text style={[styles.mobileNavText, tab === "new" && styles.mobileNavTextActive]}>New</Text></Pressable>
          <Pressable onPress={() => { setTab("history"); void refreshHistory(); }} style={styles.mobileNavItem}><Ionicons name={tab === "history" ? "time" : "time-outline"} size={24} color={tab === "history" ? "#B9A7FF" : "#777181"} /><Text style={[styles.mobileNavText, tab === "history" && styles.mobileNavTextActive]}>History</Text></Pressable>
        </View>
      ) : null}
      </View>
    </View>
  );
}

function createStyles(isDark: boolean, width: number) {
  const compact = width < 540;
  const hasIconSidebar = width >= 900;
  const c = isDark ? {
    bg: "#100E14", header: "rgba(16,14,20,0.92)", surface: "#1A181E", panel: "#18161C",
    raised: "#25222B", selected: "#2A2338", border: "#302C38", strongBorder: "#4B4262",
    text: "#F5F2FA", softText: "#E5E1ED", body: "#D0CBD9", muted: "#ABA4B9", faint: "#A39BAF",
    purpleText: "#D8CDF8", purpleSurface: "#282231", glowOne: "rgba(100,70,170,0.10)", glowTwo: "rgba(83,53,130,0.08)",
  } : {
    bg: "#F7F4FB", header: "rgba(255,255,255,0.94)", surface: "#FFFFFF", panel: "#FFFFFF",
    raised: "#EEE9F4", selected: "#EAE2F7", border: "#DDD6E6", strongBorder: "#C4B5D8",
    text: "#241D2D", softText: "#42394D", body: "#51475E", muted: "#6E637B", faint: "#71657E",
    purpleText: "#62499A", purpleSurface: "#EEE7F8", glowOne: "rgba(132,94,210,0.12)", glowTwo: "rgba(160,122,220,0.09)",
  };

  const base = StyleSheet.create({
    appShell: { flex: 1, flexDirection: "row", backgroundColor: c.bg },
    app: { flex: 1, backgroundColor: c.bg, overflow: "hidden" }, loading: { flex: 1, backgroundColor: c.bg, alignItems: "center", justifyContent: "center" },
    iconSidebar: { width: 68, backgroundColor: c.header, borderRightWidth: 1, borderRightColor: c.border, alignItems: "center", justifyContent: "center", gap: 14, zIndex: 6 },
    iconSidebarItemWrap: { position: "relative", width: "100%", alignItems: "center", justifyContent: "center" },
    iconSidebarButton: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center", alignSelf: "center", backgroundColor: "transparent" },
    iconSidebarButtonActive: { backgroundColor: "#755BD0" },
    iconSidebarTooltip: { position: "absolute", left: 54, top: 9, paddingHorizontal: 10, height: 28, borderRadius: 8, backgroundColor: c.raised, borderWidth: 1, borderColor: c.strongBorder, alignItems: "center", justifyContent: "center", zIndex: 10 },
    iconSidebarTooltipText: { color: c.text, fontFamily: "DMSans_500Medium", fontSize: 12 },
    glowOne: { position: "absolute", width: 450, height: 450, borderRadius: 225, backgroundColor: c.glowOne, top: -260, left: -160 },
    glowTwo: { position: "absolute", width: 500, height: 500, borderRadius: 250, backgroundColor: c.glowTwo, bottom: -350, right: -200 },
    header: { height: Platform.OS === "web" ? 82 : 96, paddingTop: Platform.OS === "web" ? 0 : 22, paddingLeft: hasIconSidebar ? 16 : 28, paddingRight: 28, flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.header, zIndex: 4 },
    brand: { flexDirection: "row", alignItems: "center", gap: 11 }, logo: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" }, brandName: { color: c.text, fontFamily: "DMSans_700Bold", fontSize: 19, letterSpacing: -0.4 }, brandTagline: { color: c.faint, fontFamily: "DMSans_600SemiBold", fontSize: 7.5, letterSpacing: 1.25, marginTop: 2 },
    desktopNav: { marginLeft: "auto", flexDirection: "row", gap: 8, marginRight: 18 }, navItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 15, height: 40, borderRadius: 10 }, navItemActive: { backgroundColor: c.raised }, navText: { color: c.muted, fontFamily: "DMSans_500Medium", fontSize: 13 }, navTextActive: { color: c.purpleText }, headerActions: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 10 }, themeButton: { width: 36, height: 36, borderRadius: 11, backgroundColor: c.raised, borderWidth: 1, borderColor: c.border, alignItems: "center", justifyContent: "center" }, avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.purpleSurface, borderWidth: 1, borderColor: c.strongBorder, alignItems: "center", justifyContent: "center" }, avatarText: { color: c.purpleText, fontFamily: "DMSans_700Bold", fontSize: 11 },
    mainScroll: { paddingLeft: hasIconSidebar ? 16 : 22, paddingRight: 22, paddingTop: 48, paddingBottom: 110 }, pageIntro: { width: "100%", maxWidth: hasIconSidebar ? 1500 : 1180, alignSelf: hasIconSidebar ? "flex-start" : "center", marginBottom: 22 }, eyebrow: { color: "#8063D1", fontFamily: "DMSans_700Bold", fontSize: 10, letterSpacing: 2.3, marginBottom: 10 }, heroTitle: { color: c.text, fontFamily: "DMSans_700Bold", fontSize: 34, letterSpacing: -1.25 }, heroCopy: { color: c.muted, fontFamily: "DMSans_400Regular", fontSize: 14, marginTop: 9 },
    workspace: { width: "100%", maxWidth: hasIconSidebar ? 1500 : 1180, alignSelf: hasIconSidebar ? "flex-start" : "center", gap: 22 }, workspaceWide: { flexDirection: "row", alignItems: "stretch" }, controlsColumn: { flex: 0.85, gap: 24 }, controlSection: { gap: 15 }, sectionTitle: { flexDirection: "row", alignItems: "center", gap: 10 }, numberBadge: { width: 27, height: 27, borderRadius: 8, backgroundColor: c.purpleSurface, alignItems: "center", justifyContent: "center" }, numberText: { color: "#8D6BE5", fontFamily: "DMSans_700Bold", fontSize: 10 }, sectionHeading: { color: c.softText, fontFamily: "DMSans_600SemiBold", fontSize: 14 },
    autoLanguageCard: { minHeight: 74, padding: 14, borderRadius: 15, borderWidth: 1, borderColor: "#8067CE", backgroundColor: c.selected, flexDirection: "row", alignItems: "center" }, autoLanguageIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: c.raised, alignItems: "center", justifyContent: "center", marginRight: 12 }, autoLanguageBody: { flex: 1 }, autoLanguageTitle: { color: c.purpleText, fontFamily: "DMSans_600SemiBold", fontSize: 13 }, autoLanguageHint: { color: c.faint, fontFamily: "DMSans_400Regular", fontSize: 10, lineHeight: 15, marginTop: 3 }, autoLanguageBadge: { paddingHorizontal: 8, height: 24, borderRadius: 12, backgroundColor: "#755BD0", alignItems: "center", justifyContent: "center" }, autoLanguageBadgeText: { color: "white", fontFamily: "DMSans_700Bold", fontSize: 8, letterSpacing: 0.8 },
    sessionGrid: { flexDirection: "row", gap: 10 }, sessionGridStack: { flexDirection: "column" }, sessionCard: { flex: 1, minHeight: 118, padding: 14, borderRadius: 15, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface }, sessionCardActive: { borderColor: "#8067CE", backgroundColor: c.selected }, sessionIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: c.raised, alignItems: "center", justifyContent: "center", marginBottom: 10 }, sessionIconActive: { backgroundColor: "#755BD0" }, sessionLabel: { color: c.body, fontFamily: "DMSans_600SemiBold", fontSize: 13 }, sessionLabelActive: { color: c.purpleText }, sessionHint: { color: c.faint, fontFamily: "DMSans_400Regular", fontSize: 9.5, marginTop: 3 },
    toggleCard: { minHeight: 74, padding: 14, borderRadius: 15, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, flexDirection: "row", alignItems: "center" }, toggleIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: c.purpleSurface, alignItems: "center", justifyContent: "center", marginRight: 12 }, toggleText: { flex: 1 }, toggleTitle: { color: c.softText, fontFamily: "DMSans_600SemiBold", fontSize: 13 }, toggleHint: { color: c.faint, fontFamily: "DMSans_400Regular", fontSize: 10, marginTop: 3 },
    meetingCard: { gap: 11, padding: 14, borderRadius: 15, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface }, meetingHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, roomCode: { color: c.purpleText, fontFamily: "DMSans_700Bold", fontSize: 15, letterSpacing: 1.5 }, meetingInput: { height: 44, borderRadius: 11, borderWidth: 1, borderColor: c.border, backgroundColor: c.raised, color: c.text, paddingHorizontal: 13, fontFamily: "DMSans_500Medium", fontSize: 12 }, meetingJoinRow: { flexDirection: "row", gap: 9 }, meetingCodeInput: { flex: 1, letterSpacing: 1.3 }, joinButton: { width: 86, borderRadius: 11, backgroundColor: c.purpleSurface, borderWidth: 1, borderColor: c.strongBorder, alignItems: "center", justifyContent: "center" }, joinButtonText: { color: c.purpleText, fontFamily: "DMSans_700Bold", fontSize: 11 }, participantList: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, participantChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 9, height: 30, borderRadius: 15, backgroundColor: c.raised }, participantText: { color: c.body, fontFamily: "DMSans_500Medium", fontSize: 10 },
    primaryWrap: { borderRadius: 14, overflow: "hidden", marginTop: -4 }, primaryButton: { height: 55, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 }, primaryText: { color: "white", fontFamily: "DMSans_600SemiBold", fontSize: 14 }, privacyRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, marginTop: -13 }, privacyText: { color: c.faint, fontFamily: "DMSans_400Regular", fontSize: 8.5, textAlign: "center" },
    transcriptCard: { flex: 1, minHeight: 535, borderRadius: 20, borderWidth: 1, borderColor: c.border, backgroundColor: c.panel, overflow: "hidden" }, transcriptHeader: { height: 88, paddingHorizontal: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: c.border }, panelEyebrow: { color: c.faint, fontFamily: "DMSans_700Bold", fontSize: 8, letterSpacing: 1.7 }, panelTitle: { color: c.softText, fontFamily: "DMSans_600SemiBold", fontSize: 15, marginTop: 5 }, liveBadge: { paddingHorizontal: 10, height: 25, borderRadius: 12.5, backgroundColor: "rgba(229,72,103,0.13)", flexDirection: "row", alignItems: "center", gap: 6 }, idleBadge: { backgroundColor: c.raised }, liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#F15E78" }, idleDot: { backgroundColor: c.muted }, liveText: { color: "#E0526D", fontFamily: "DMSans_700Bold", fontSize: 8, letterSpacing: 1 }, idleText: { color: c.muted },
    waveform: { height: 78, marginHorizontal: 22, marginTop: 14, paddingHorizontal: 10, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.raised, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3 }, waveBar: { width: 3, borderRadius: 3, backgroundColor: "#9F7AEA" }, timelineRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 22, paddingTop: 10, paddingBottom: 14 }, timeText: { color: c.faint, fontFamily: "DMSans_500Medium", fontSize: 8 }, timeline: { flex: 1, height: 1, backgroundColor: c.border }, transcriptScroll: { flex: 1, borderTopWidth: 1, borderTopColor: c.border }, transcriptContent: { flexGrow: 1, padding: 22 }, emptyTranscript: { flex: 1, minHeight: 230, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 }, emptyIcon: { width: 55, height: 55, borderRadius: 27.5, backgroundColor: c.raised, alignItems: "center", justifyContent: "center", marginBottom: 14 }, emptyTitle: { color: c.body, fontFamily: "DMSans_600SemiBold", fontSize: 13 }, emptyCopy: { color: c.faint, fontFamily: "DMSans_400Regular", fontSize: 10.5, lineHeight: 16, textAlign: "center", marginTop: 6 }, segmentRow: { flexDirection: "row", marginBottom: 19 }, segmentTime: { width: 42, color: c.faint, fontFamily: "DMSans_500Medium", fontSize: 9, paddingTop: 2 }, speakerLine: { width: 2, borderRadius: 2, marginRight: 12 }, segmentBody: { flex: 1 }, segmentMeta: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 4 }, speakerName: { fontFamily: "DMSans_700Bold", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.7 }, languageTag: { color: c.faint, backgroundColor: c.raised, borderRadius: 7, overflow: "hidden", paddingHorizontal: 6, paddingVertical: 2, fontFamily: "DMSans_600SemiBold", fontSize: 7.5, textTransform: "uppercase", letterSpacing: 0.5 }, segmentText: { color: c.body, fontFamily: "DMSans_400Regular", fontSize: 12.5, lineHeight: 19 },
    segmentUncertain: { paddingHorizontal: 6, backgroundColor: "rgba(245,158,11,0.10)", borderWidth: 1, borderColor: "rgba(245,158,11,0.25)" }, uncertainTag: { color: "#D99115", fontFamily: "DMSans_700Bold", fontSize: 7.5 }, translatedText: { color: c.purpleText, fontFamily: "DMSans_400Regular", fontSize: 11.5, lineHeight: 18, marginTop: 5, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: "#755BD0" }, sourceText: { color: c.faint, fontFamily: "DMSans_400Regular", fontSize: 10.5, lineHeight: 16, marginTop: 4, opacity: 0.75 }, segmentEditRow: { flexDirection: "row", alignItems: "center", gap: 8 }, segmentEditInput: { flex: 1, minHeight: 42, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: c.strongBorder, color: c.body, backgroundColor: c.raised, fontFamily: "DMSans_400Regular", fontSize: 12 }, segmentEditSave: { width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: "#755BD0" },
    exportActions: { paddingHorizontal: 22, paddingBottom: 16, flexDirection: "row", flexWrap: "wrap", gap: 8 }, exportButton: { minHeight: 38, paddingHorizontal: 12, borderRadius: 11, borderWidth: 1, borderColor: c.strongBorder, backgroundColor: c.purpleSurface, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 }, exportButtonPressed: { opacity: 0.72 }, exportButtonDisabled: { opacity: 0.58 }, exportButtonSuccess: { borderColor: "rgba(52,185,129,0.38)", backgroundColor: "rgba(52,185,129,0.10)" }, exportButtonText: { color: c.purpleText, fontFamily: "DMSans_600SemiBold", fontSize: 10.5 }, exportButtonSuccessText: { color: "#34B981" },
    summaryEmptyCard: { marginBottom: 20, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: c.strongBorder, backgroundColor: c.purpleSurface, flexDirection: "row", alignItems: "center", gap: 11 }, summaryIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.raised, alignItems: "center", justifyContent: "center" }, summaryEmptyBody: { flex: 1 }, summaryTitle: { color: c.purpleText, fontFamily: "DMSans_700Bold", fontSize: 11.5 }, summaryHint: { color: c.muted, fontFamily: "DMSans_400Regular", fontSize: 9, lineHeight: 13, marginTop: 3 }, summaryGenerateButton: { minHeight: 36, paddingHorizontal: 11, borderRadius: 10, backgroundColor: "#755BD0", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }, summaryGenerateText: { color: "white", fontFamily: "DMSans_700Bold", fontSize: 9.5 },
    summaryCard: { marginBottom: 22, padding: 16, borderRadius: 15, borderWidth: 1, borderColor: c.strongBorder, backgroundColor: c.purpleSurface }, summaryHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }, summaryHeadingRow: { flexDirection: "row", alignItems: "center", gap: 7 }, summaryMiniActions: { flexDirection: "row", gap: 6 }, summaryMiniButton: { width: 30, height: 30, borderRadius: 9, borderWidth: 1, borderColor: c.strongBorder, backgroundColor: c.raised, alignItems: "center", justifyContent: "center" }, summaryOverview: { color: c.body, fontFamily: "DMSans_400Regular", fontSize: 11.5, lineHeight: 18 }, summarySection: { marginTop: 15, gap: 7 }, summarySectionTitle: { color: c.purpleText, fontFamily: "DMSans_700Bold", fontSize: 9, letterSpacing: 0.7, textTransform: "uppercase" }, summaryPointRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 }, summaryBullet: { width: 5, height: 5, borderRadius: 3, backgroundColor: "#9F7AEA", marginTop: 6 }, summaryPointText: { flex: 1, color: c.body, fontFamily: "DMSans_400Regular", fontSize: 10.5, lineHeight: 16 }, summaryActionItem: { padding: 10, borderRadius: 10, backgroundColor: c.raised, gap: 5 }, summaryActionMeta: { color: c.faint, fontFamily: "DMSans_500Medium", fontSize: 8.5, marginLeft: 20 },
    processingCard: { marginHorizontal: 22, marginBottom: 16, padding: 14, borderRadius: 13, borderWidth: 1, borderColor: c.strongBorder, backgroundColor: c.purpleSurface, flexDirection: "row", alignItems: "center", gap: 12 }, processingBody: { flex: 1 }, processingTitle: { color: c.purpleText, fontFamily: "DMSans_700Bold", fontSize: 11 }, processingCopy: { color: c.muted, fontFamily: "DMSans_400Regular", fontSize: 9.5, lineHeight: 14, marginTop: 3 },
    historyPage: { paddingHorizontal: 22, paddingTop: 16, paddingBottom: 90 }, historyLayout: { width: "100%", maxWidth: 1180, alignSelf: "center", gap: 22 }, historyLayoutWide: { flexDirection: "row", alignItems: "flex-start" }, historyList: { flex: 0.85, gap: 10 }, historyResultsScroll: { width: "100%" }, historyResultsContent: { gap: 9, paddingBottom: 8 }, historyEmpty: { minHeight: 220, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: c.border, borderStyle: "dashed", backgroundColor: c.surface, alignItems: "center", justifyContent: "center", gap: 7 }, historyTranscriptPane: { flex: 1.15, minWidth: 0, gap: 10 }, historyTranscriptHeading: { minHeight: 54, paddingHorizontal: 4, justifyContent: "center" }, historyTranscriptLabel: { color: c.faint, fontFamily: "DMSans_700Bold", fontSize: 8, letterSpacing: 1.4 }, historyTranscriptTitle: { color: c.softText, fontFamily: "DMSans_600SemiBold", fontSize: 15, marginTop: 4 }, historyDetail: { width: "100%", maxWidth: 760, alignSelf: "center" }, historyDetailActions: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }, historyBackButton: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8 }, historyBackText: { color: c.purpleText, fontFamily: "DMSans_600SemiBold", fontSize: 12 }, historyDeleteButton: { width: 38, height: 38, borderRadius: 11, borderWidth: 1, borderColor: "rgba(239,106,127,0.25)", backgroundColor: "rgba(239,106,127,0.08)", alignItems: "center", justifyContent: "center" }, historyDetailTitle: { color: c.text, fontFamily: "DMSans_700Bold", fontSize: 20, lineHeight: 27, marginBottom: 18 }, historyItem: { minHeight: 75, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, paddingHorizontal: 14, flexDirection: "row", alignItems: "center" }, historyItemSelected: { borderColor: "#745FC0", backgroundColor: c.selected }, historyIcon: { width: 40, height: 40, borderRadius: 11, backgroundColor: c.purpleSurface, alignItems: "center", justifyContent: "center", marginRight: 12 }, historyBody: { flex: 1, minWidth: 0 }, historyTitle: { color: c.softText, fontFamily: "DMSans_600SemiBold", fontSize: 12.5 }, historyMetaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }, historyMeta: { flexShrink: 1, color: c.faint, fontFamily: "DMSans_400Regular", fontSize: 9.5 }, historyDuration: { flexDirection: "row", alignItems: "center", gap: 3 }, historyDurationText: { color: c.faint, fontFamily: "DMSans_500Medium", fontSize: 9.5 }, historyStatus: { maxWidth: 128, minHeight: 25, paddingHorizontal: 8, borderRadius: 12.5, backgroundColor: c.purpleSurface, flexDirection: "row", alignItems: "center", gap: 5, marginLeft: 8 }, historyStatusCompleted: { backgroundColor: "rgba(52,211,153,0.12)" }, historyStatusFailed: { backgroundColor: "rgba(239,92,117,0.12)" }, historyStatusText: { color: c.purpleText, fontFamily: "DMSans_700Bold", fontSize: 7.5, textTransform: "uppercase" }, historyStatusCompletedText: { color: "#34B981" }, historyStatusFailedText: { color: "#E0526D" }, historyRowDelete: { width: 34, height: 34, marginLeft: 4, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    modalOverlay: { flex: 1, padding: 22, backgroundColor: "rgba(7,5,12,0.68)", alignItems: "center", justifyContent: "center" }, deleteDialog: { width: "100%", maxWidth: 390, padding: 24, borderRadius: 20, borderWidth: 1, borderColor: c.strongBorder, backgroundColor: c.panel, alignItems: "center" }, deleteDialogIcon: { width: 46, height: 46, borderRadius: 23, backgroundColor: "rgba(239,106,127,0.12)", alignItems: "center", justifyContent: "center", marginBottom: 14 }, deleteDialogTitle: { color: c.text, fontFamily: "DMSans_700Bold", fontSize: 18 }, deleteDialogCopy: { color: c.muted, fontFamily: "DMSans_400Regular", fontSize: 12, lineHeight: 18, textAlign: "center", marginTop: 8 }, deleteDialogError: { color: "#EF6A7F", fontFamily: "DMSans_500Medium", fontSize: 11, textAlign: "center", marginTop: 10 }, deleteDialogActions: { width: "100%", flexDirection: "row", gap: 10, marginTop: 22 }, deleteCancelButton: { flex: 1, height: 44, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.raised, alignItems: "center", justifyContent: "center" }, deleteCancelText: { color: c.body, fontFamily: "DMSans_600SemiBold", fontSize: 12 }, deleteConfirmButton: { flex: 1, height: 44, borderRadius: 12, backgroundColor: "#D94B67", flexDirection: "row", gap: 7, alignItems: "center", justifyContent: "center" }, deleteConfirmText: { color: "white", fontFamily: "DMSans_700Bold", fontSize: 12 },
    historyFilters: { gap: 10, marginBottom: 4, padding: 13, borderRadius: 16, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface }, historyFilterHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, historyFilterTitle: { color: c.softText, fontFamily: "DMSans_700Bold", fontSize: 13 }, historyFilterCount: { color: c.faint, fontFamily: "DMSans_400Regular", fontSize: 9, marginTop: 2 }, historyClearButton: { minHeight: 29, paddingHorizontal: 9, borderRadius: 9, borderWidth: 1, borderColor: c.strongBorder, backgroundColor: c.purpleSurface, flexDirection: "row", alignItems: "center", gap: 4 }, historyClearText: { color: c.purpleText, fontFamily: "DMSans_600SemiBold", fontSize: 9 }, historySearchBox: { height: 47, paddingHorizontal: 7, borderRadius: 13, borderWidth: 1, borderColor: c.strongBorder, backgroundColor: c.raised, flexDirection: "row", alignItems: "center", gap: 8 }, historySearchIcon: { width: 32, height: 32, borderRadius: 9, backgroundColor: c.purpleSurface, alignItems: "center", justifyContent: "center" }, historySearchReset: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center" }, historySearchInput: { flex: 1, color: c.body, fontFamily: "DMSans_400Regular", fontSize: 11.5, paddingVertical: 0, outlineWidth: 0 }, historyFilterPills: { gap: 7 }, historyFilterPill: { minHeight: 29, paddingHorizontal: 11, borderRadius: 10, borderWidth: 1, borderColor: "transparent", backgroundColor: c.raised, alignItems: "center", justifyContent: "center" }, historyFilterPillActive: { borderColor: "#8B70DC", backgroundColor: "#755BD0" }, historyFilterText: { color: c.muted, fontFamily: "DMSans_600SemiBold", fontSize: 9 }, historyFilterTextActive: { color: "white" },
    mobileNav: { position: "absolute", bottom: 0, left: 0, right: 0, height: Platform.OS === "ios" ? 82 : 68, paddingBottom: Platform.OS === "ios" ? 15 : 3, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.header, flexDirection: "row", justifyContent: "space-around", alignItems: "center" }, mobileNavItem: { width: 90, alignItems: "center", gap: 2 }, mobileNavText: { color: c.faint, fontFamily: "DMSans_500Medium", fontSize: 9 }, mobileNavTextActive: { color: c.purpleText },
  });

  // Keep small supporting labels legible across web and native screens.
  const readable = Object.fromEntries(Object.entries(base).map(([key, value]) => {
    const style = value as typeof value & { fontSize?: number; lineHeight?: number };
    return [key, style.fontSize == null ? style : {
      ...style,
      fontSize: Math.max(11, style.fontSize),
      ...(style.lineHeight == null ? {} : { lineHeight: Math.max(17, style.lineHeight) }),
    }];
  })) as typeof base;

  return StyleSheet.create({
    ...readable,
    header: { ...base.header, paddingLeft: compact ? 18 : hasIconSidebar ? 16 : 32, paddingRight: compact ? 18 : 32 },
    brandTagline: { ...base.brandTagline, fontSize: 9, letterSpacing: 1 },
    themeButton: { ...base.themeButton, width: 44, height: 44, borderRadius: 14 },
    mainScroll: { ...base.mainScroll, paddingLeft: compact ? 18 : hasIconSidebar ? 16 : 32, paddingRight: compact ? 18 : 32, paddingTop: compact ? 28 : hasIconSidebar ? 26 : 44 },
    pageIntro: { ...base.pageIntro, marginBottom: 30 },
    heroTitle: { ...base.heroTitle, fontSize: compact ? 30 : 40, lineHeight: compact ? 38 : 49 },
    heroCopy: { ...base.heroCopy, fontSize: 15, lineHeight: 23, maxWidth: 540 },
    workspace: { ...base.workspace, gap: 28 },
    controlsColumn: { ...base.controlsColumn, minWidth: 0, gap: 24 },
    sectionHeading: { ...base.sectionHeading, flexShrink: 1, fontSize: 15 },
    sessionGrid: { ...base.sessionGrid, flexWrap: "wrap", gap: 12 },
    sessionGridStack: { flexDirection: "row", flexWrap: "wrap" },
    sessionCard: { ...base.sessionCard, flexBasis: "30%", flexGrow: 1, minHeight: 128, padding: 16 },
    sessionLabel: { ...base.sessionLabel, fontSize: 15 },
    sessionHint: { ...base.sessionHint, fontSize: 12, lineHeight: 18, marginTop: 5 },
    toggleCard: { ...base.toggleCard, padding: 16, gap: 4 },
    toggleTitle: { ...base.toggleTitle, fontSize: 14 },
    toggleHint: { ...base.toggleHint, fontSize: 12, lineHeight: 18 },
    primaryButton: { ...base.primaryButton, height: 58 },
    primaryText: { ...base.primaryText, fontSize: 16 },
    privacyRow: { ...base.privacyRow, alignItems: "flex-start", paddingHorizontal: 8 },
    privacyText: { ...base.privacyText, flexShrink: 1, fontSize: 11, lineHeight: 17 },
    transcriptCard: { ...base.transcriptCard, minWidth: 0, minHeight: compact ? 480 : 620 },
    transcriptHeader: { ...base.transcriptHeader, paddingHorizontal: compact ? 16 : 24, gap: 10 },
    panelTitle: { ...base.panelTitle, fontSize: 18 },
    transcriptContent: { ...base.transcriptContent, padding: compact ? 16 : 24 },
    segmentText: { ...base.segmentText, fontSize: 15, lineHeight: 25 },
    segmentMeta: { ...base.segmentMeta, flexWrap: "wrap" },
    emptyTitle: { ...base.emptyTitle, fontSize: 16, textAlign: "center" },
    emptyCopy: { ...base.emptyCopy, fontSize: 13, lineHeight: 21 },
    exportButton: { ...base.exportButton, minHeight: 44 },
    summaryEmptyCard: { ...base.summaryEmptyCard, flexWrap: "wrap" },
    summaryGenerateButton: { ...base.summaryGenerateButton, minHeight: 44 },
    summaryOverview: { ...base.summaryOverview, fontSize: 14, lineHeight: 23 },
    summaryPointText: { ...base.summaryPointText, fontSize: 13, lineHeight: 21 },
    historyPage: { ...base.historyPage, paddingHorizontal: compact ? 16 : 32, paddingTop: 28 },
    historyFilters: { ...base.historyFilters, padding: 16, gap: 14 },
    historyFilterTitle: { ...base.historyFilterTitle, fontSize: 20 },
    historyFilterPill: { ...base.historyFilterPill, minHeight: 38 },
    historyItem: { ...base.historyItem, minHeight: 90, paddingHorizontal: compact ? 10 : 16 },
    historyTitle: { ...base.historyTitle, fontSize: 14 },
    historyIcon: { ...base.historyIcon, marginRight: compact ? 8 : 12 },
    historyStatus: { ...base.historyStatus, maxWidth: compact ? 76 : 128 },
    historyMetaRow: { ...base.historyMetaRow, flexWrap: "wrap", gap: 4 },
    historyRowDelete: { ...base.historyRowDelete, width: 40, height: 44 },
    mobileNavItem: { ...base.mobileNavItem, minHeight: 48, justifyContent: "center", gap: 4 },
  });
}
