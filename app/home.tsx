import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  FlatList,
  ScrollView,
  ActivityIndicator,
  Platform,
  Modal,
  Alert,
  Image,
  TextInput,
  Animated as RNAnimated,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { Audio } from "expo-av";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  speechRecognitionAvailable,
} from "@/lib/speechRecognition";
import Colors from "@/constants/colors";
import { useClassroom } from "@/lib/classroom";
import { supabase, type Child, type Observation, type AttendanceEvent } from "@/lib/supabase";
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import AsyncStorage from '@react-native-async-storage/async-storage';

type RecordingTab = "voice" | "photo";
type UiState = "idle" | "recording" | "parsing" | "saved" | "error";

type QueueItem = {
  id: string;
  transcript: string;
  photoUri: string | null;
  classChildren: Child[];
  classroomId: string;
  status: "queued" | "processing" | "failed";
  queuedAt: number;
};

type FeedItem =
  | ({ _type: "placeholder" } & QueueItem)
  | ({ _type: "observation" } & Observation);

type LeftTab = 'attendance' | 'nap';
type MainTab = 'today' | 'children' | 'plan';
type ProfileWindow = '7d' | '28d';
type SnapshotState = 'idle' | 'loading' | 'done';
type PlanCardStatus = 'planned' | 'done' | 'skipped';
type PlanGenerateState = 'idle' | 'loading' | 'error' | 'done';

type PlanCard = {
  id: string;
  title: string;
  description: string;
  day: string;
  timeOfDay: string;
  hdlhTag: string;
  status: PlanCardStatus;
  rationale: string;
};

const CHILD_BG_COLORS = [
  "#F97B6B", "#7BC4A0", "#6BA3F9", "#F9C76B",
  "#B87BF9", "#F96BA3", "#6BF9C7", "#F9A36B",
];

const HDLH_FOUNDATIONS: { key: string; label: string }[] = [
  { key: 'Belonging', label: 'Belonging' },
  { key: 'WellBeing', label: 'Well-Being' },
  { key: 'Engagement', label: 'Engagement' },
  { key: 'Expression', label: 'Expression' },
];

const QUEUE_STORAGE_KEY = 'peekabloom_queue';

function getTodayISO(): string {
  return new Date().toISOString().split('T')[0];
}

async function saveQueueToStorage(queue: QueueItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.error('[Peekabloom] Failed to save queue:', e);
  }
}

async function loadQueueFromStorage(): Promise<QueueItem[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return [];
    const items: QueueItem[] = JSON.parse(raw);
    return items
      .filter(q => q.status !== 'failed')
      .map(q => q.status === 'processing' ? { ...q, status: 'queued' as const } : q);
  } catch (e) {
    console.error('[Peekabloom] Failed to load queue:', e);
    return [];
  }
}


async function fetchTodayEvents(classroomId: string): Promise<AttendanceEvent[]> {
  const today = getTodayISO();
  const { data } = await supabase
    .from('attendance_events')
    .select('*')
    .eq('classroom_id', classroomId)
    .eq('date', today)
    .order('recorded_at', { ascending: true });
  return (data as AttendanceEvent[]) ?? [];
}

async function addEvent(
  childId: string,
  classroomId: string,
  eventType: AttendanceEvent['event_type'],
  recordedAt?: Date
): Promise<void> {
  const today = getTodayISO();
  await supabase.from('attendance_events').insert({
    child_id: childId,
    classroom_id: classroomId,
    event_type: eventType,
    recorded_at: (recordedAt ?? new Date()).toISOString(),
    date: today,
  });
}

function lastEventTypeFor(
  childId: string,
  events: AttendanceEvent[],
  types: [AttendanceEvent['event_type'], AttendanceEvent['event_type']]
): AttendanceEvent['event_type'] | undefined {
  return events
    .filter(e => e.child_id === childId && (e.event_type === types[0] || e.event_type === types[1]))
    .sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1))
    .at(-1)?.event_type;
}

function isCheckedIn(childId: string, events: AttendanceEvent[]): boolean {
  return lastEventTypeFor(childId, events, ['checkin', 'checkout']) === 'checkin';
}

function isNapping(childId: string, events: AttendanceEvent[]): boolean {
  return lastEventTypeFor(childId, events, ['nap_start', 'nap_end']) === 'nap_start';
}

function getInitials(name: string): string {
  const words = (name || "").trim().split(/\s+/);
  return words.length >= 2
    ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
    : (words[0]?.[0] || "?").toUpperCase();
}

const EVENT_TYPE_LABELS: Record<AttendanceEvent['event_type'], string> = {
  checkin: 'Check In',
  checkout: 'Check Out',
  nap_start: 'Nap Start',
  nap_end: 'Nap End',
};

function showOfflineAlert() {
  Alert.alert('WiFi Required', 'Please connect to WiFi to record updates.');
}

function toHHMM(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatTimestamp(created_at: string): string {
  const date = new Date(created_at);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const obsDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (obsDay.getTime() === today.getTime()) {
    return `Today ${date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  } else if (obsDay.getTime() === yesterday.getTime()) {
    return "Yesterday";
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function usePhotoUri(photoUrl: string | null): string | null {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  useEffect(() => {
    if (!photoUrl) { setPhotoUri(null); return; }
    if (photoUrl.startsWith('http')) { setPhotoUri(photoUrl); return; }
    supabase.storage.from('photos').createSignedUrl(photoUrl, 3600)
      .then(({ data }) => { if (data?.signedUrl) setPhotoUri(data.signedUrl); });
  }, [photoUrl]);
  return photoUri;
}

function ChildCard({ child, index, onPress }: { child: Child; index: number; onPress?: () => void }) {
  const initials = getInitials(child.name);
  const bg = CHILD_BG_COLORS[index % CHILD_BG_COLORS.length];

  return (
    <Animated.View entering={FadeInDown.duration(400).delay(index * 50)}>
      <TouchableOpacity
        style={styles.childCard}
        activeOpacity={0.75}
        onPress={() => {
          if (Platform.OS !== "web") {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }
          onPress?.();
        }}
      >
        <View style={[styles.childAvatar, { backgroundColor: bg }]}>
          <Text style={styles.childInitials}>{initials}</Text>
        </View>
        <Text style={styles.childName} numberOfLines={1}>
          {child.name}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function AttendanceChildCard({
  child,
  index,
  leftTab,
  checkedIn,
  napping,
  onTap,
  onLongPress,
}: {
  child: Child;
  index: number;
  leftTab: LeftTab;
  checkedIn: boolean;
  napping: boolean;
  onTap: () => void;
  onLongPress: () => void;
}) {
  const initials = getInitials(child.name);

  let cardBg: string;
  let textColor = "#FFFFFF";
  let opacity = 1;

  if (leftTab === 'attendance') {
    if (checkedIn) {
      cardBg = Colors.primary;
    } else {
      cardBg = "#3A3A3A";
      textColor = Colors.textMuted;
      opacity = 0.4;
    }
  } else {
    if (!checkedIn) {
      cardBg = "#3A3A3A";
      textColor = Colors.textMuted;
      opacity = 0.4;
    } else if (napping) {
      cardBg = "#F5A623";
    } else {
      cardBg = "#7BC4A0";
    }
  }

  return (
    <Animated.View entering={FadeInDown.duration(400).delay(index * 50)} style={{ opacity }}>
      <TouchableOpacity
        style={[styles.childCard, { backgroundColor: cardBg }]}
        activeOpacity={0.75}
        onPress={onTap}
        onLongPress={onLongPress}
      >
        {leftTab === 'nap' && napping ? (
          <View style={attendanceStyles.moonBadge}>
            <Ionicons name="moon" size={10} color="#FFFFFF" />
          </View>
        ) : null}
        <View style={[styles.childAvatar, { backgroundColor: 'rgba(255,255,255,0.25)' }]}>
          <Text style={styles.childInitials}>{initials}</Text>
        </View>
        <Text style={[styles.childName, { color: textColor }]} numberOfLines={1}>
          {child.name}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

function EventRow({
  evt,
  onSave,
  onDelete,
}: {
  evt: AttendanceEvent;
  onSave: (eventId: string, newTime: Date) => void;
  onDelete: (eventId: string) => void;
}) {
  const [timeValue, setTimeValue] = useState(() => toHHMM(evt.recorded_at));

  useEffect(() => {
    setTimeValue(toHHMM(evt.recorded_at));
  }, [evt.recorded_at]);

  return (
    <View style={attendanceStyles.eventRow}>
      <Text style={attendanceStyles.eventLabel}>{EVENT_TYPE_LABELS[evt.event_type]}</Text>
      <TextInput
        style={attendanceStyles.eventTimeInput}
        value={timeValue}
        onChangeText={setTimeValue}
        onBlur={() => {
          const parts = timeValue.split(':');
          const h = parseInt(parts[0], 10);
          const m = parseInt(parts[1], 10);
          if (isNaN(h) || isNaN(m)) return;
          const newTime = new Date(evt.recorded_at);
          newTime.setHours(h, m, 0, 0);
          onSave(evt.id, newTime);
        }}
        keyboardType="numbers-and-punctuation"
      />
      <TouchableOpacity style={attendanceStyles.eventDeleteBtn} onPress={() => onDelete(evt.id)}>
        <Ionicons name="trash-outline" size={18} color={Colors.error} />
      </TouchableOpacity>
    </View>
  );
}

function EditAttendanceModal({
  child,
  events,
  onClose,
  onSave,
  onDelete,
}: {
  child: Child | null;
  events: AttendanceEvent[];
  onClose: () => void;
  onSave: (eventId: string, newTime: Date) => void;
  onDelete: (eventId: string) => void;
}) {
  return (
    <Modal visible={child !== null} animationType="fade" transparent>
      <View style={styles.modalOverlay}>
        <View style={styles.modalBox}>
          <Text style={styles.modalTitle}>{child?.name ?? ''} — Today's Events</Text>
          {events.length === 0 ? (
            <Text style={attendanceStyles.noEventsText}>No events recorded today.</Text>
          ) : (
            events.map((evt) => (
              <EventRow key={evt.id} evt={evt} onSave={onSave} onDelete={onDelete} />
            ))
          )}
          <View style={styles.modalActions}>
            <TouchableOpacity style={styles.modalCancelBtn} onPress={onClose}>
              <Text style={styles.modalCancelText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function ObservationCard({
  obs,
  child,
  onApprove,
  onEdit,
  onDelete,
}: {
  obs: Observation;
  child: Child | undefined;
  onApprove: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const photoUri = usePhotoUri(obs.photo_url);

  const isPending = obs.status === "pending";
  const hdlhTags = Array.isArray(obs.hdlh_tags) ? obs.hdlh_tags : [];
  const electTags = Array.isArray(obs.elect_tags) ? obs.elect_tags : [];

  const recordTypeConfig = useMemo(() =>
    obs.record_type === "incident"
      ? { borderColor: "#E74C3C", badgeLabel: "Incident" }
      : obs.record_type === "health"
      ? { borderColor: "#F5A623", badgeLabel: "Health" }
      : null,
  [obs.record_type]);

  const recordBorderStyle = recordTypeConfig
    ? { borderLeftWidth: 3, borderLeftColor: recordTypeConfig.borderColor }
    : undefined;

  const structuredFields = useMemo(() => {
    if (!obs.structured_fields) return null;
    if (typeof obs.structured_fields === 'string') {
      try { return JSON.parse(obs.structured_fields); } catch { return null; }
    }
    return obs.structured_fields;
  }, [obs.structured_fields]);

  return (
    <View style={[feedStyles.card, isPending && feedStyles.cardPending, recordBorderStyle]}>
      {recordTypeConfig ? (
        <View style={[feedStyles.recordBadge, { backgroundColor: recordTypeConfig.borderColor }]}>
          <Text style={feedStyles.recordBadgeText}>{recordTypeConfig.badgeLabel}</Text>
        </View>
      ) : null}
      <View style={feedStyles.cardHeader}>
        <Text style={feedStyles.cardChildName}>{child?.name ?? "Unknown"}</Text>
        <Text style={feedStyles.cardTimestamp}>{formatTimestamp(obs.created_at)}</Text>
      </View>
      <Text style={feedStyles.cardContent}>{obs.parsed_content}</Text>
      {recordTypeConfig && structuredFields ? (
        <View style={feedStyles.structuredBox}>
          {structuredFields.time_of_incident != null ? (
            <View style={feedStyles.structuredRow}>
              <Text style={feedStyles.structuredLabel}>Time:</Text>
              <Text style={feedStyles.structuredValue}>{structuredFields.time_of_incident}</Text>
            </View>
          ) : null}
          {structuredFields.location != null ? (
            <View style={feedStyles.structuredRow}>
              <Text style={feedStyles.structuredLabel}>Location:</Text>
              <Text style={feedStyles.structuredValue}>{structuredFields.location}</Text>
            </View>
          ) : null}
          {structuredFields.what_happened != null ? (
            <View style={feedStyles.structuredRow}>
              <Text style={feedStyles.structuredLabel}>What happened:</Text>
              <Text style={feedStyles.structuredValue}>{structuredFields.what_happened}</Text>
            </View>
          ) : null}
          {structuredFields.action_taken != null ? (
            <View style={feedStyles.structuredRow}>
              <Text style={feedStyles.structuredLabel}>Action taken:</Text>
              <Text style={feedStyles.structuredValue}>{structuredFields.action_taken}</Text>
            </View>
          ) : null}
          {structuredFields.parent_notified != null ? (
            <View style={feedStyles.structuredRow}>
              <Text style={feedStyles.structuredLabel}>Parents notified:</Text>
              <Text style={feedStyles.structuredValue}>{structuredFields.parent_notified ? "Yes" : "No"}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {photoUri ? (
        <Image source={{ uri: photoUri }} style={feedStyles.cardPhoto} resizeMode="cover" />
      ) : null}
      {hdlhTags.length > 0 || electTags.length > 0 ? (
        <View style={feedStyles.tagsRow}>
          {[...hdlhTags, ...electTags].map((tag, idx) => (
            <View key={`${idx}-${tag}`} style={feedStyles.tag}>
              <Text style={feedStyles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {isPending ? (
        <View style={feedStyles.actions}>
          <TouchableOpacity style={feedStyles.approveBtn} onPress={onApprove}>
            <Ionicons name="checkmark" size={15} color="#FFFFFF" />
            <Text style={feedStyles.actionBtnText}>Approve</Text>
          </TouchableOpacity>
          <TouchableOpacity style={feedStyles.editBtn} onPress={onEdit}>
            <Ionicons name="pencil" size={15} color="#FFFFFF" />
            <Text style={feedStyles.actionBtnText}>Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity style={feedStyles.deleteBtn} onPress={onDelete}>
            <Ionicons name="trash" size={15} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

function PlaceholderCard({
  item,
  onRetry,
  onDismiss,
  isOnline,
}: {
  item: QueueItem;
  onRetry: () => void;
  onDismiss: () => void;
  isOnline: boolean;
}) {
  const pulse = useRef(new RNAnimated.Value(1)).current;
  const [elapsed, setElapsed] = useState(Date.now() - item.queuedAt);

  useEffect(() => {
    if (item.status === "failed") return;
    const anim = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(pulse, { toValue: 0.4, duration: 800, useNativeDriver: true }),
        RNAnimated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [item.status, pulse]);

  useEffect(() => {
    if (item.status === "failed") return;
    const timer = setInterval(() => setElapsed(Date.now() - item.queuedAt), 1000);
    return () => clearInterval(timer);
  }, [item.status, item.queuedAt]);

  const isFailed = item.status === "failed";

  return (
    <RNAnimated.View
      style={[
        placeholderStyles.card,
        isFailed && placeholderStyles.cardFailed,
        { opacity: isFailed ? 1 : pulse },
      ]}
    >
      <View style={placeholderStyles.row}>
        {isFailed ? (
          <Ionicons name="alert-circle" size={18} color="#C0392B" />
        ) : (
          <ActivityIndicator size="small" color="#E07A6B" />
        )}
        <Text style={[placeholderStyles.label, isFailed && placeholderStyles.labelFailed, { flex: 1 }]}>
          {isFailed ? "Failed to save" : !isOnline && item.status === "queued" ? "Waiting for connection" : "Processing..."}
        </Text>
        {isFailed ? (
          <TouchableOpacity onPress={onDismiss} hitSlop={8}>
            <Ionicons name="close" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>
      {!isFailed && elapsed > 5000 ? (
        <Text style={placeholderStyles.subText}>
          May take a moment on slow connections
        </Text>
      ) : null}
      {isFailed ? (
        <TouchableOpacity style={placeholderStyles.retryBtn} onPress={onRetry}>
          <Text style={placeholderStyles.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      ) : null}
    </RNAnimated.View>
  );
}

function VoiceRecorder({
  classChildren,
  classroomId,
  onQueued,
  isOnline,
}: {
  classChildren: Child[];
  classroomId: string;
  onQueued: (data: { transcript: string; photoUri: string | null }) => void;
  isOnline: boolean;
}) {
  "use no memo";
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [uiState, setUiState] = useState<UiState>("idle");

  const recordingRef = useRef<Audio.Recording | null>(null);
  const transcriptRef = useRef("");

  useSpeechRecognitionEvent("result", (event) => {
    const text = event.results?.[0]?.transcript ?? "";
    transcriptRef.current = text;
    setTranscript(text);
  });

  const handlePressIn = async () => {
    if (!isOnline) {
      showOfflineAlert();
      return;
    }
    if (uiState !== "idle") return;
    try {
      if (Platform.OS !== "web") {
        const micPerm = await Audio.requestPermissionsAsync();
        if (!micPerm.granted) {
          setUiState("error");
          return;
        }
        if (speechRecognitionAvailable) {
          const speechPerm =
            await ExpoSpeechRecognitionModule.requestPermissionsAsync();
          if (!speechPerm.granted) {
            setUiState("error");
            return;
          }
          ExpoSpeechRecognitionModule.start({
            lang: "en-US",
            continuous: true,
            interimResults: true,
          });
        }
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });
        const { recording } = await Audio.Recording.createAsync(
          Audio.RecordingOptionsPresets.HIGH_QUALITY,
        );
        recordingRef.current = recording;
      }
      transcriptRef.current = "";
      setTranscript("");
      setIsRecording(true);
      setUiState("recording");
    } catch (e) {
      console.error("[Peekabloom] Start recording error:", e);
      setUiState("error");
    }
  };

  const handlePressOut = async () => {
    if (uiState !== "recording") return;
    try {
      if (Platform.OS !== "web") {
        if (speechRecognitionAvailable) {
          ExpoSpeechRecognitionModule.stop();
        }
        if (recordingRef.current) {
          await recordingRef.current.stopAndUnloadAsync();
          recordingRef.current = null;
        }
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      }
      const finalTranscript = transcriptRef.current.trim();
      setIsRecording(false);
      setTranscript("");
      transcriptRef.current = "";
      onQueued({ transcript: finalTranscript, photoUri: null });
      setUiState("saved");
      setTimeout(() => setUiState("idle"), 1000);
    } catch (e) {
      console.error("[Peekabloom] Stop recording error:", e);
      setIsRecording(false);
      setUiState("error");
    }
  };

  const btnColor =
    uiState === "recording"
      ? "#D96A5C"
      : uiState === "parsing"
        ? Colors.textMuted
        : uiState === "saved"
          ? Colors.success
          : uiState === "error"
            ? Colors.error
            : Colors.primary;

  const hintText =
    uiState === "recording"
      ? "Recording..."
      : uiState === "saved"
        ? "Queued ✓"
        : uiState === "error"
          ? "Try Again"
          : "Hold to Record";

  return (
    <View style={styles.recordArea}>
      {uiState === "recording" && transcript ? (
        <Text style={styles.transcriptText} numberOfLines={4}>
          {transcript}
        </Text>
      ) : null}

      <TouchableOpacity
        style={[styles.recordBtn, { backgroundColor: btnColor }]}
        activeOpacity={0.85}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={uiState === "parsing" || uiState === "saved"}
        onPress={uiState === "error" ? () => setUiState("idle") : undefined}
      >
        {uiState === "parsing" ? (
          <ActivityIndicator color="#FFFFFF" size="large" />
        ) : uiState === "saved" ? (
          <Ionicons name="checkmark" size={36} color="#FFFFFF" />
        ) : (
          <Ionicons name="mic" size={32} color="#FFFFFF" />
        )}
      </TouchableOpacity>

      <Text style={[styles.recordHint, uiState === "error" && styles.hintError]}>
        {hintText}
      </Text>
    </View>
  );
}

async function compressPhoto(uri: string): Promise<string> {
  // First pass: resize to max 1200px wide, quality 0.7
  let result = await manipulateAsync(
    uri,
    [{ resize: { width: 1200 } }],
    { compress: 0.7, format: SaveFormat.JPEG }
  );

  // Check size
  const response = await fetch(result.uri);
  const blob = await response.blob();

  // Second pass if still over 250KB: reduce further
  if (blob.size > 250000) {
    result = await manipulateAsync(
      result.uri,
      [{ resize: { width: 900 } }],
      { compress: 0.6, format: SaveFormat.JPEG }
    );
  }

  return result.uri;
}

type ParsedObsRow = {
  child_id: string;
  classroom_id: string;
  parsed_content: string;
  hdlh_tags: unknown;
  elect_tags: unknown;
  photo_url: string | null;
  status: string;
  record_type?: string;
  needs_director_review?: boolean;
  structured_fields?: unknown;
};

async function processQueueItem(item: QueueItem): Promise<void> {
  let photoPath: string | null = null;

  if (item.photoUri) {
    const compressedUri = await compressPhoto(item.photoUri);
    const photoResponse = await fetch(compressedUri);
    const photoBlob = await photoResponse.blob();
    console.log("[Peekabloom] compressed blob size:", photoBlob.size, "type:", photoBlob.type);

    const path = `${Date.now()}.jpg`;
    const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    const uploadUrl = `${supabaseUrl}/storage/v1/object/photos/${path}`;

    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", uploadUrl);
        xhr.setRequestHeader("Authorization", `Bearer ${supabaseKey}`);
        xhr.setRequestHeader("apikey", supabaseKey!);
        xhr.setRequestHeader("Content-Type", "image/jpeg");
        xhr.timeout = 30000;
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
        };
        xhr.onerror = () => reject(new Error("XHR error"));
        xhr.ontimeout = () => reject(new Error("Upload timed out"));
        xhr.send(photoBlob);
      });
      photoPath = path;
    } catch (uploadErr) {
      console.error("[Peekabloom] Storage upload failed — check Supabase photos bucket RLS policy", uploadErr);
    }
  }

  const parseUrl = process.env.EXPO_PUBLIC_PARSING_API_URL;
  const parseKey = process.env.EXPO_PUBLIC_PARSING_API_KEY;
  let apiObservations: ParsedObsRow[] = [];

  if (item.transcript) {
    const parseResponse = await fetch(`${parseUrl}/api/parse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${parseKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: item.transcript,
        children: item.classChildren,
        classroom_id: item.classroomId,
        photo_url: photoPath,
      }),
    });
    if (parseResponse.ok) {
      const data = await parseResponse.json();
      apiObservations = data.observations ?? [];
    }
  }

  let rows;
  if (apiObservations.length > 0) {
    rows = apiObservations.map((obs) => ({
      child_id: obs.child_id,
      classroom_id: obs.classroom_id,
      raw_transcript: item.transcript,
      parsed_content: obs.parsed_content,
      hdlh_tags: obs.hdlh_tags,
      elect_tags: obs.elect_tags,
      photo_url: photoPath,
      status: obs.status ?? "pending",
      record_type: obs.record_type ?? "observation",
      needs_director_review: obs.needs_director_review ?? false,
      structured_fields: obs.structured_fields ?? null,
    }));
  } else {
    throw new Error('API returned no observations — names not recognized');
  }

  const { error: saveError } = await supabase.from("observations").insert(rows);
  if (saveError) throw saveError;
}

type PhotoState = "idle" | "camera" | "preview" | "describing" | "parsing" | "saved" | "error";

function PhotoRecorder({
  onQueued,
  isOnline,
}: {
  onQueued: (data: { transcript: string; photoUri: string | null }) => void;
  isOnline: boolean;
}) {
  "use no memo";
  const [permission, requestPermission] = useCameraPermissions();
  const [photoState, setPhotoState] = useState<PhotoState>("idle");
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [isRecording, setIsRecording] = useState(false);

  const cameraRef = useRef<CameraView>(null);
  const transcriptRef = useRef("");

  useSpeechRecognitionEvent("result", (event) => {
    if (isRecording) {
      const text = event.results?.[0]?.transcript ?? "";
      transcriptRef.current = text;
      setTranscript(text);
    }
  });

  const openCamera = async () => {
    if (!permission?.granted) {
      const { granted } = await requestPermission();
      if (!granted) {
        Alert.alert(
          "Camera Permission Required",
          "Peekabloom needs camera access to capture photos of children's activities.",
          [{ text: "OK" }]
        );
        return;
      }
    }
    setPhotoState("camera");
  };

  const takePicture = async () => {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 1 });
      if (photo) {
        setCapturedUri(photo.uri);
        setPhotoState("preview");
      }
    } catch (e) {
      console.error("[Peekabloom] takePicture error:", e);
    }
  };

  const handleRetake = () => {
    setCapturedUri(null);
    setPhotoState("camera");
  };

  const handleUsePhoto = () => {
    transcriptRef.current = "";
    setTranscript("");
    setPhotoState("describing");
  };

  const handlePressIn = async () => {
    if (!isOnline) {
      showOfflineAlert();
      return;
    }
    if (photoState !== "describing") return;
    try {
      if (Platform.OS !== "web" && speechRecognitionAvailable) {
        const speechPerm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (speechPerm.granted) {
          ExpoSpeechRecognitionModule.start({ lang: "en-US", continuous: true, interimResults: true });
        }
      }
      transcriptRef.current = "";
      setTranscript("");
      setIsRecording(true);
    } catch (e) {
      console.error("[Peekabloom] Photo record start error:", e);
      setPhotoState("error");
    }
  };

  const handlePressOut = async () => {
    if (!isRecording) return;
    try {
      if (Platform.OS !== "web" && speechRecognitionAvailable) {
        ExpoSpeechRecognitionModule.stop();
      }
      const finalTranscript = transcriptRef.current.trim();
      setIsRecording(false);
      setTranscript("");
      transcriptRef.current = "";
      onQueued({ transcript: finalTranscript, photoUri: capturedUri! });
      setPhotoState("saved");
      setTimeout(() => {
        setPhotoState("idle");
        setCapturedUri(null);
      }, 1000);
    } catch (e) {
      console.error("[Peekabloom] Photo record stop error:", e);
      setIsRecording(false);
      setPhotoState("error");
    }
  };

  // Camera / preview modal
  const showModal = photoState === "camera" || photoState === "preview";

  // Describing / processing states share the hold-to-record UI
  const inRecordingFlow =
    photoState === "describing" ||
    photoState === "saved" ||
    photoState === "error";

  if (inRecordingFlow) {
    const btnColor = isRecording
      ? "#D96A5C"
      : photoState === "saved"
        ? Colors.success
        : photoState === "error"
          ? Colors.error
          : Colors.primary;

    const hintText = isRecording
      ? "Recording..."
      : photoState === "saved"
        ? "Queued ✓"
        : photoState === "error"
          ? "Try Again"
          : "Describe this photo...";

    return (
      <View style={styles.recordArea}>
        {isRecording && transcript ? (
          <Text style={styles.transcriptText} numberOfLines={4}>{transcript}</Text>
        ) : null}
        <TouchableOpacity
          style={[styles.recordBtn, { backgroundColor: btnColor }]}
          activeOpacity={0.85}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          disabled={photoState === "saved"}
          onPress={photoState === "error" ? () => setPhotoState("describing") : undefined}
        >
          {photoState === "saved" ? (
            <Ionicons name="checkmark" size={36} color="#FFFFFF" />
          ) : (
            <Ionicons name="mic" size={32} color="#FFFFFF" />
          )}
        </TouchableOpacity>
        <Text style={[styles.recordHint, photoState === "error" && styles.hintError]}>
          {hintText}
        </Text>
      </View>
    );
  }

  return (
    <>
      <View style={styles.recordArea}>
        <TouchableOpacity
          style={[styles.recordBtn, { backgroundColor: Colors.success }]}
          activeOpacity={0.8}
          onPress={openCamera}
          disabled={showModal}
        >
          <Ionicons name="camera" size={32} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.recordHint}>Tap to Capture</Text>
      </View>

      <Modal visible={showModal} animationType="slide" statusBarTranslucent>
        {photoState === "camera" ? (
          <View style={cameraStyles.container}>
            <CameraView ref={cameraRef} style={cameraStyles.camera} facing="back" />
            <View style={cameraStyles.controls}>
              <TouchableOpacity
                style={cameraStyles.cancelBtn}
                onPress={() => setPhotoState("idle")}
              >
                <Ionicons name="close" size={28} color="#FFFFFF" />
              </TouchableOpacity>
              <TouchableOpacity style={cameraStyles.shutterBtn} onPress={takePicture}>
                <View style={cameraStyles.shutterInner} />
              </TouchableOpacity>
              <View style={{ width: 56 }} />
            </View>
          </View>
        ) : capturedUri ? (
          <View style={cameraStyles.container}>
            <Image source={{ uri: capturedUri }} style={cameraStyles.preview} resizeMode="contain" />
            <View style={cameraStyles.previewControls}>
              <TouchableOpacity style={cameraStyles.retakeBtn} onPress={handleRetake}>
                <Text style={cameraStyles.retakeBtnText}>Retake</Text>
              </TouchableOpacity>
              <TouchableOpacity style={cameraStyles.usePhotoBtn} onPress={handleUsePhoto}>
                <Text style={cameraStyles.usePhotoBtnText}>Use Photo</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
      </Modal>
    </>
  );
}

function ProfileObsRow({ obs }: { obs: Observation }) {
  const photoUri = usePhotoUri(obs.photo_url);

  return (
    <View style={profileStyles.obsRow}>
      <View style={profileStyles.obsRowText}>
        <Text style={profileStyles.obsContent}>{obs.parsed_content}</Text>
        <Text style={profileStyles.obsDate}>{formatTimestamp(obs.created_at)}</Text>
      </View>
      {photoUri ? (
        <Image source={{ uri: photoUri }} style={profileStyles.obsThumb} resizeMode="cover" />
      ) : null}
    </View>
  );
}

function ChildProfileModal({ child, classroomId, onClose }: {
  child: Child | null;
  classroomId: string;
  onClose: () => void;
}) {
  const [profileWindow, setProfileWindow] = useState<ProfileWindow>('28d');
  const [observations, setObservations] = useState<Observation[]>([]);
  const [obsLoading, setObsLoading] = useState(false);
  const [snapshotState, setSnapshotState] = useState<SnapshotState>('idle');
  const [snapshotText, setSnapshotText] = useState('');

  useEffect(() => {
    if (!child) return;
    let cancelled = false;
    setObsLoading(true);
    setSnapshotState('idle');
    setSnapshotText('');
    const days = profileWindow === '7d' ? 7 : 28;
    const since = new Date();
    since.setDate(since.getDate() - days);
    supabase
      .from('observations')
      .select('id, child_id, parsed_content, hdlh_tags, photo_url, created_at')
      .eq('child_id', child.id)
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (cancelled) return;
        setObservations((data as Observation[]) ?? []);
        setObsLoading(false);
      });
    return () => { cancelled = true; };
  }, [child?.id, profileWindow]);

  const handleGenerateSnapshot = async () => {
    if (!child) return;
    const parseUrl = process.env.EXPO_PUBLIC_PARSING_API_URL;
    const parseKey = process.env.EXPO_PUBLIC_PARSING_API_KEY;
    setSnapshotState('loading');
    try {
      const res = await fetch(`${parseUrl}/daily-summary`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${parseKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ child_id: child.id, classroom_id: classroomId, window: profileWindow }),
      });
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      setSnapshotText(data.summary ?? '');
      setSnapshotState('done');
    } catch {
      setSnapshotState('idle');
    }
  };

  const handleCertify = async () => {
    if (!child) return;
    const { data: authData } = await supabase.auth.getUser();
    await supabase.from('child_profile_snapshots').insert({
      child_id: child.id,
      classroom_id: classroomId,
      time_window: profileWindow,
      summary: snapshotText,
      certified_by: authData.user?.id ?? null,
      certified_at: new Date().toISOString(),
    });
    setSnapshotState('idle');
    setSnapshotText('');
  };

  const { avatarBg, initials } = useMemo(() => {
    if (!child) return { avatarBg: CHILD_BG_COLORS[0], initials: '?' };
    let hash = 0;
    for (let i = 0; i < child.id.length; i++) hash = (hash + child.id.charCodeAt(i)) % CHILD_BG_COLORS.length;
    return { avatarBg: CHILD_BG_COLORS[hash], initials: getInitials(child.name) };
  }, [child?.id, child?.name]);

  const sections = useMemo(() => {
    const generalObs = observations.filter(o => !Array.isArray(o.hdlh_tags) || o.hdlh_tags.length === 0);
    return [
      ...HDLH_FOUNDATIONS.map(f => ({
        key: f.key,
        label: f.label,
        obs: observations.filter(o => Array.isArray(o.hdlh_tags) && o.hdlh_tags.includes(f.key)),
      })),
      { key: 'General', label: 'General', obs: generalObs },
    ];
  }, [observations]);

  if (!child) return null;

  return (
    <Modal visible animationType="fade" transparent>
      <View style={profileStyles.overlay}>
        <View style={profileStyles.sheet}>
          {/* Header */}
          <View style={profileStyles.header}>
            <View style={[profileStyles.headerAvatar, { backgroundColor: avatarBg }]}>
              <Text style={profileStyles.headerInitials}>{initials}</Text>
            </View>
            <Text style={profileStyles.headerName}>{child.name}</Text>
            <TouchableOpacity style={profileStyles.closeBtn} onPress={onClose}>
              <Ionicons name="close" size={24} color={Colors.textMuted} />
            </TouchableOpacity>
          </View>

          {/* Time window selector */}
          <View style={profileStyles.windowRow}>
            {(['7d', '28d'] as ProfileWindow[]).map(w => (
              <TouchableOpacity
                key={w}
                style={[profileStyles.windowBtn, profileWindow === w && profileStyles.windowBtnActive]}
                onPress={() => setProfileWindow(w)}
              >
                <Text style={[profileStyles.windowBtnText, profileWindow === w && profileStyles.windowBtnTextActive]}>
                  {w === '7d' ? '7 days' : '28 days'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Body */}
          {obsLoading ? (
            <View style={profileStyles.loadingBox}>
              <ActivityIndicator color={Colors.primary} />
            </View>
          ) : (
            <ScrollView
              style={profileStyles.body}
              contentContainerStyle={profileStyles.bodyContent}
              showsVerticalScrollIndicator={false}
            >
              {/* HDLH + General sections */}
              {sections.map(section => (
                <View key={section.key} style={profileStyles.section}>
                  <Text style={profileStyles.sectionTitle}>{section.label}</Text>
                  {section.obs.length === 0 ? (
                    <Text style={profileStyles.sectionEmpty}>No observations yet</Text>
                  ) : (
                    section.obs.map(obs => <ProfileObsRow key={obs.id} obs={obs} />)
                  )}
                </View>
              ))}

              {/* Portfolio snapshot */}
              <View style={profileStyles.snapshotSection}>
                <Text style={profileStyles.sectionTitle}>Portfolio Snapshot</Text>
                {snapshotState === 'idle' && (
                  <TouchableOpacity style={profileStyles.generateBtn} onPress={handleGenerateSnapshot}>
                    <Ionicons name="sparkles-outline" size={16} color="#FFFFFF" />
                    <Text style={profileStyles.generateBtnText}>Generate Snapshot</Text>
                  </TouchableOpacity>
                )}
                {snapshotState === 'loading' && (
                  <View style={profileStyles.snapshotLoading}>
                    <ActivityIndicator color={Colors.primary} size="small" />
                    <Text style={profileStyles.snapshotLoadingText}>Generating...</Text>
                  </View>
                )}
                {snapshotState === 'done' && (
                  <View style={profileStyles.snapshotCard}>
                    <Text style={profileStyles.snapshotText}>{snapshotText}</Text>
                    <View style={profileStyles.snapshotActions}>
                      <TouchableOpacity style={profileStyles.certifyBtn} onPress={handleCertify}>
                        <Ionicons name="checkmark-circle" size={16} color="#FFFFFF" />
                        <Text style={profileStyles.certifyBtnText}>Certify</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={profileStyles.dismissBtn}
                        onPress={() => { setSnapshotState('idle'); setSnapshotText(''); }}
                      >
                        <Text style={profileStyles.dismissBtnText}>Dismiss</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ── PlanCardView ──────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<PlanCardStatus, string> = {
  planned: 'Planned',
  done: 'Done',
  skipped: 'Skipped',
};
const STATUS_NEXT: Record<PlanCardStatus, PlanCardStatus> = {
  planned: 'done',
  done: 'skipped',
  skipped: 'planned',
};

function PlanCardView({
  card,
  onStatusCycle,
  onDismiss,
}: {
  card: PlanCard;
  onStatusCycle: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <View style={planStyles.card}>
      <View style={planStyles.cardHeader}>
        <Text style={planStyles.cardTitle}>{card.title}</Text>
        <TouchableOpacity onPress={() => onDismiss(card.id)} hitSlop={8}>
          <Ionicons name="close" size={16} color={Colors.textMuted} />
        </TouchableOpacity>
      </View>
      <Text style={planStyles.cardDescription}>{card.description}</Text>
      <View style={planStyles.cardPills}>
        <View style={planStyles.pill}>
          <Text style={planStyles.pillText}>{card.day}</Text>
        </View>
        <View style={planStyles.pill}>
          <Text style={planStyles.pillText}>{card.timeOfDay}</Text>
        </View>
        <View style={[planStyles.pill, planStyles.hdlhPill]}>
          <Text style={planStyles.hdlhPillText}>{card.hdlhTag}</Text>
        </View>
        <TouchableOpacity
          style={[planStyles.statusPill, card.status === 'done' && planStyles.statusPillDone, card.status === 'skipped' && planStyles.statusPillSkipped]}
          onPress={() => onStatusCycle(card.id)}
        >
          <Text style={planStyles.statusPillText}>{STATUS_LABELS[card.status]}</Text>
        </TouchableOpacity>
      </View>
      {!!card.rationale && (
        <Text style={planStyles.cardRationale}>{card.rationale}</Text>
      )}
    </View>
  );
}

// ── PlanTab ───────────────────────────────────────────────────────────────────

type HdlhCounts = { Belonging: number; WellBeing: number; Engagement: number; Expression: number };
const EMPTY_COUNTS: HdlhCounts = { Belonging: 0, WellBeing: 0, Engagement: 0, Expression: 0 };

function PlanTab({ classroomId }: { classroomId: string }) {
  const parseUrl = process.env.EXPO_PUBLIC_PARSING_API_URL;

  const [hdlhCounts, setHdlhCounts] = useState<HdlhCounts>(EMPTY_COUNTS);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [planCards, setPlanCards] = useState<PlanCard[]>([]);
  const [planState, setPlanState] = useState<PlanGenerateState>('idle');

  useEffect(() => {
    if (!classroomId) return;
    let cancelled = false;
    setSnapshotLoading(true);
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    supabase
      .from('observations')
      .select('id, hdlh_tags')
      .eq('classroom_id', classroomId)
      .gte('created_at', since)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const counts: HdlhCounts = { ...EMPTY_COUNTS };
        for (const row of data) {
          const tags: string[] = Array.isArray(row.hdlh_tags) ? row.hdlh_tags : [];
          for (const tag of tags) {
            const key = tag as keyof HdlhCounts;
            if (key in counts) counts[key]++;
          }
        }
        setHdlhCounts(counts);
        setSnapshotLoading(false);
      });
    return () => { cancelled = true; };
  }, [classroomId]);

  const maxCount = useMemo(
    () => Math.max(1, ...Object.values(hdlhCounts)),
    [hdlhCounts],
  );
  const hasGap = Object.values(hdlhCounts).some((c) => c === 0);

  const handleGeneratePlan = useCallback(async () => {
    if (!parseUrl) return;
    setPlanState('loading');
    try {
      const res = await fetch(`${parseUrl}/api/weekly-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          classroom_id: classroomId,
          hdlh_snapshot: {
            belonging: hdlhCounts.Belonging,
            wellbeing: hdlhCounts.WellBeing,
            engagement: hdlhCounts.Engagement,
            expression: hdlhCounts.Expression,
          },
          window: '14d',
        }),
      });
      if (!res.ok) throw new Error('Plan generation failed');
      const json = await res.json();
      const cards: PlanCard[] = (json.cards ?? []).map(
        (c: Omit<PlanCard, 'status'> & { status?: PlanCardStatus }) => ({
          ...c,
          status: c.status ?? 'planned',
        }),
      );
      setPlanCards(cards);
      setPlanState('done');
    } catch {
      setPlanState('error');
    }
  }, [parseUrl, classroomId, hdlhCounts]);

  const handleStatusCycle = useCallback((id: string) => {
    setPlanCards((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: STATUS_NEXT[c.status] } : c)),
    );
  }, []);

  const handleDismiss = useCallback((id: string) => {
    setPlanCards((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return (
    <ScrollView style={planStyles.screen} contentContainerStyle={planStyles.screenContent}>
      <Text style={mainTabStyles.screenTitle}>Plan</Text>

      {/* HDLH Snapshot */}
      <View style={planStyles.section}>
        <Text style={planStyles.sectionTitle}>Classroom Snapshot · Last 14 Days</Text>
        {snapshotLoading ? (
          <ActivityIndicator color={Colors.primary} style={planStyles.loadingIndicator} />
        ) : (
          <>
            {hasGap && (
              <View style={planStyles.gapWarning}>
                <Ionicons name="warning-outline" size={14} color="#F5A623" />
                <Text style={planStyles.gapWarningText}>Some foundations have no observations yet</Text>
              </View>
            )}
            <View style={planStyles.foundationGrid}>
              {HDLH_FOUNDATIONS.map(({ key, label }) => {
                const count = hdlhCounts[key as keyof HdlhCounts];
                const fill = count / maxCount;
                const active = count > 0;
                return (
                  <View key={key} style={[planStyles.foundationCard, active && planStyles.foundationCardActive]}>
                    <Text style={planStyles.foundationCount}>{count}</Text>
                    <Text style={planStyles.foundationLabel}>{label}</Text>
                    <View style={planStyles.foundationBarBg}>
                      <View
                        style={[
                          planStyles.foundationBarFill,
                          {
                            width: `${Math.round(fill * 100)}%` as unknown as number,
                            backgroundColor: active ? Colors.primary : Colors.textDark,
                          },
                        ]}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          </>
        )}
      </View>

      {/* Weekly Plan */}
      <View style={planStyles.section}>
        <View style={planStyles.sectionHeader}>
          <Text style={planStyles.sectionTitle}>Weekly Plan</Text>
          {planState !== 'loading' && (
            <TouchableOpacity style={planStyles.generateBtn} onPress={handleGeneratePlan}>
              <Ionicons name="sparkles-outline" size={15} color="#FFFFFF" />
              <Text style={planStyles.generateBtnText}>Generate Plan</Text>
            </TouchableOpacity>
          )}
        </View>
        {planState === 'loading' && (
          <View style={planStyles.loadingRow}>
            <ActivityIndicator color={Colors.primary} />
            <Text style={planStyles.loadingText}>Generating weekly plan…</Text>
          </View>
        )}
        {planState === 'error' && (
          <Text style={planStyles.errorText}>Failed to generate plan. Tap Generate Plan to retry.</Text>
        )}
        {planCards.map((card) => (
          <PlanCardView
            key={card.id}
            card={card}
            onStatusCycle={handleStatusCycle}
            onDismiss={handleDismiss}
          />
        ))}
      </View>
    </ScrollView>
  );
}

export default function HomeScreen() {
  const {
    classroomId,
    classroomName,
    isLoading: classroomLoading,
    clearClassroom,
  } = useClassroom();
  const insets = useSafeAreaInsets();
  const [children, setChildren] = useState<Child[]>([]);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isOnline, setIsOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [activeMainTab, setActiveMainTab] = useState<MainTab>('today');
  const [selectedChild, setSelectedChild] = useState<Child | null>(null);
  const [activeTab, setActiveTab] = useState<RecordingTab>("voice");
  const [leftTab, setLeftTab] = useState<LeftTab>('attendance');
  const [todayEvents, setTodayEvents] = useState<AttendanceEvent[]>([]);
  const [editingChild, setEditingChild] = useState<Child | null>(null);
  const [editingObs, setEditingObs] = useState<Observation | null>(null);
  const [editText, setEditText] = useState("");

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  const fetchChildren = useCallback(async () => {
    if (!classroomId) return;
    const { data } = await supabase
      .from("children")
      .select("*")
      .eq("classroom_id", classroomId)
      .order("name");
    if (data) setChildren(data);
  }, [classroomId]);

  const fetchFeed = useCallback(async () => {
    if (!classroomId) return;
    const { data } = await supabase
      .from("observations")
      .select("id, child_id, classroom_id, parsed_content, hdlh_tags, elect_tags, photo_url, status, created_at, record_type, needs_director_review, structured_fields")
      .eq("classroom_id", classroomId)
      .order("created_at", { ascending: false });
    if (data) {
      setObservations(data as Observation[]);
    }
  }, [classroomId]);

  useEffect(() => {
    if (!classroomLoading && !classroomId) {
      router.replace("/");
      return;
    }
    Promise.all([
      fetchChildren(),
      fetchFeed(),
      loadQueueFromStorage().then(setQueue),
      fetchTodayEvents(classroomId!).then(setTodayEvents),
    ]).finally(() => setLoading(false));
  }, [classroomId, classroomLoading, fetchChildren, fetchFeed]);

  useEffect(() => {
    let cancelled = false;

    async function checkConnection() {
      try {
        const response = await fetch('https://www.google.com/generate_204', {
          method: 'HEAD',
          cache: 'no-cache',
        });
        if (!cancelled) setIsOnline(response.ok);
      } catch {
        if (!cancelled) setIsOnline(false);
      }
    }

    checkConnection();
    const interval = setInterval(checkConnection, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    saveQueueToStorage(queue);
  }, [queue]);

  const handleApprove = useCallback(async (id: string) => {
    await supabase.from("observations").update({ status: "approved" }).eq("id", id);
    fetchFeed();
  }, [fetchFeed]);

  const handleDelete = useCallback(async (id: string) => {
    await supabase.from("observations").delete().eq("id", id);
    fetchFeed();
  }, [fetchFeed]);

  const refreshTodayEvents = useCallback(async () => {
    setTodayEvents(await fetchTodayEvents(classroomId!));
  }, [classroomId]);

  const attendanceStatusMap = useMemo(() => {
    const byChild = new Map<string, AttendanceEvent[]>();
    for (const e of todayEvents) {
      const arr = byChild.get(e.child_id);
      if (arr) arr.push(e);
      else byChild.set(e.child_id, [e]);
    }
    const map = new Map<string, { checkedIn: boolean; napping: boolean }>();
    for (const child of children) {
      const evts = byChild.get(child.id) ?? [];
      map.set(child.id, {
        checkedIn: isCheckedIn(child.id, evts),
        napping: isNapping(child.id, evts),
      });
    }
    return map;
  }, [children, todayEvents]);

  const handleChildTap = useCallback(async (child: Child) => {
    const { checkedIn, napping } = attendanceStatusMap.get(child.id) ?? { checkedIn: false, napping: false };
    if (leftTab === 'attendance') {
      await addEvent(child.id, classroomId!, checkedIn ? 'checkout' : 'checkin');
    } else {
      if (!checkedIn) return;
      await addEvent(child.id, classroomId!, napping ? 'nap_end' : 'nap_start');
    }
    await refreshTodayEvents();
  }, [leftTab, attendanceStatusMap, classroomId, refreshTodayEvents]);

  const handleSaveEventTime = useCallback(async (eventId: string, newTime: Date) => {
    await supabase
      .from('attendance_events')
      .update({ recorded_at: newTime.toISOString() })
      .eq('id', eventId);
    await refreshTodayEvents();
  }, [refreshTodayEvents]);

  const handleDeleteEvent = useCallback(async (eventId: string) => {
    await supabase
      .from('attendance_events')
      .delete()
      .eq('id', eventId);
    await refreshTodayEvents();
  }, [refreshTodayEvents]);

  const handleEdit = useCallback((obs: Observation) => {
    setEditingObs(obs);
    setEditText(obs.parsed_content);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editingObs) return;
    await supabase
      .from("observations")
      .update({ parsed_content: editText })
      .eq("id", editingObs.id);
    setEditingObs(null);
    fetchFeed();
  }, [editingObs, editText, fetchFeed]);

  const handleQueued = useCallback((data: { transcript: string; photoUri: string | null }) => {
    const now = Date.now();
    setQueue((prev) => [
      ...prev,
      {
        id: String(now),
        transcript: data.transcript,
        photoUri: data.photoUri,
        classChildren: children,
        classroomId: classroomId!,
        status: "queued" as const,
        queuedAt: now,
      },
    ]);
  }, [children, classroomId]);

  const processQueue = useCallback(async () => {
    if (!isOnline) return;
    let next: QueueItem | undefined;
    for (const q of queue) {
      if (q.status === "processing") return;
      if (!next && q.status === "queued") next = q;
    }
    if (!next) return;

    setQueue((prev) =>
      prev.map((q) => (q.id === next.id ? { ...q, status: "processing" as const } : q))
    );

    try {
      await processQueueItem(next);
      setQueue((prev) => prev.filter((q) => q.id !== next.id));
      fetchFeed();
    } catch (e) {
      console.error("[Peekabloom] Queue processing failed:", e);
      setQueue((prev) =>
        prev.map((q) => (q.id === next.id ? { ...q, status: "failed" as const } : q))
      );
    }
  }, [isOnline, queue, fetchFeed]);

  useEffect(() => {
    processQueue();
  }, [processQueue, isOnline]);

  const childMap = useMemo(() => new Map(children.map((c) => [c.id, c])), [children]);
  const pendingCount = useMemo(() => observations.filter((o) => o.status === "pending").length, [observations]);
  const editingChildEvents = useMemo(() =>
    editingChild
      ? todayEvents
          .filter(e => e.child_id === editingChild.id)
          .sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1))
      : [],
    [editingChild, todayEvents]
  );

  const feedData = useMemo<FeedItem[]>(
    () => [
      ...queue.map((q) => ({ ...q, _type: "placeholder" as const })),
      ...observations.map((o) => ({ ...o, _type: "observation" as const })),
    ],
    [queue, observations]
  );

  const renderChild = useCallback(({ item, index }: { item: Child; index: number }) => {
    const status = attendanceStatusMap.get(item.id) ?? { checkedIn: false, napping: false };
    return (
      <AttendanceChildCard
        child={item}
        index={index}
        leftTab={leftTab}
        checkedIn={status.checkedIn}
        napping={status.napping}
        onTap={() => handleChildTap(item)}
        onLongPress={() => setEditingChild(item)}
      />
    );
  }, [leftTab, attendanceStatusMap, handleChildTap]);

  const renderFeedItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      if (item._type === "placeholder") {
        return (
          <PlaceholderCard
            item={item}
            isOnline={isOnline}
            onRetry={() =>
              setQueue((prev) =>
                prev.map((q) => (q.id === item.id ? { ...q, status: "queued" as const } : q))
              )
            }
            onDismiss={() =>
              setQueue((prev) => prev.filter((q) => q.id !== item.id))
            }
          />
        );
      }
      return (
        <ObservationCard
          obs={item}
          child={childMap.get(item.child_id)}
          onApprove={() => handleApprove(item.id)}
          onEdit={() => handleEdit(item)}
          onDelete={() => handleDelete(item.id)}
        />
      );
    },
    [isOnline, childMap, handleApprove, handleEdit, handleDelete]
  );

  if (classroomLoading || loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <StatusBar style="light" />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top + webTopInset, paddingBottom: insets.bottom + webBottomInset },
      ]}
    >
      <StatusBar style="light" />

      {/* MAIN TAB BAR */}
      <View style={mainTabStyles.tabBar}>
        <TouchableOpacity
          style={[mainTabStyles.tab, activeMainTab === 'today' && mainTabStyles.tabActive]}
          activeOpacity={0.75}
          onPress={() => setActiveMainTab('today')}
        >
          <Ionicons name="today-outline" size={20} color={activeMainTab === 'today' ? Colors.primary : Colors.textMuted} />
          <Text style={[mainTabStyles.tabText, activeMainTab === 'today' && mainTabStyles.tabTextActive]}>Today</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[mainTabStyles.tab, activeMainTab === 'children' && mainTabStyles.tabActive]}
          activeOpacity={0.75}
          onPress={() => setActiveMainTab('children')}
        >
          <Ionicons name="people-outline" size={20} color={activeMainTab === 'children' ? Colors.primary : Colors.textMuted} />
          <Text style={[mainTabStyles.tabText, activeMainTab === 'children' && mainTabStyles.tabTextActive]}>Children</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[mainTabStyles.tab, activeMainTab === 'plan' && mainTabStyles.tabActive]}
          activeOpacity={0.75}
          onPress={() => setActiveMainTab('plan')}
        >
          <Ionicons name="calendar-outline" size={20} color={activeMainTab === 'plan' ? Colors.primary : Colors.textMuted} />
          <Text style={[mainTabStyles.tabText, activeMainTab === 'plan' && mainTabStyles.tabTextActive]}>Plan</Text>
        </TouchableOpacity>
      </View>

      {/* TODAY TAB */}
      {activeMainTab === 'today' && (
        <>
          <View style={styles.panels}>
            {/* LEFT PANEL — attendance / nap */}
            <View style={styles.leftPanel}>
              <View style={styles.leftHeader}>
                <View style={styles.leftHeaderTitle}>
                  <View style={styles.classroomDot} />
                  <Text style={styles.classroomName} numberOfLines={1}>
                    {classroomName || "Classroom"}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.logoutBtn}
                  activeOpacity={0.6}
                  onPress={async () => {
                    await clearClassroom();
                    router.replace("/");
                  }}
                >
                  <Ionicons name="log-out-outline" size={20} color={Colors.textMuted} />
                </TouchableOpacity>
              </View>

              <View style={attendanceStyles.leftTabRow}>
                <TouchableOpacity
                  style={[attendanceStyles.leftTab, leftTab === 'attendance' && attendanceStyles.leftTabActive]}
                  activeOpacity={0.75}
                  onPress={() => setLeftTab('attendance')}
                >
                  <Text style={[attendanceStyles.leftTabText, leftTab === 'attendance' && attendanceStyles.leftTabTextActive]}>
                    Attendance
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[attendanceStyles.leftTab, leftTab === 'nap' && attendanceStyles.leftTabActive]}
                  activeOpacity={0.75}
                  onPress={() => setLeftTab('nap')}
                >
                  <Text style={[attendanceStyles.leftTabText, leftTab === 'nap' && attendanceStyles.leftTabTextActive]}>
                    Nap
                  </Text>
                </TouchableOpacity>
              </View>

              {children.length === 0 ? (
                <Animated.View entering={FadeIn.duration(400)} style={styles.emptyState}>
                  <Ionicons name="people-outline" size={40} color={Colors.textDark} />
                  <Text style={styles.emptyTitle}>No children yet</Text>
                </Animated.View>
              ) : (
                <FlatList
                  data={children}
                  renderItem={renderChild}
                  keyExtractor={(item) => item.id}
                  numColumns={2}
                  columnWrapperStyle={styles.gridRow}
                  contentContainerStyle={styles.gridContent}
                  showsVerticalScrollIndicator={false}
                />
              )}
            </View>

            {/* MIDDLE PANEL — classroom feed */}
            <View style={styles.middlePanel}>
              <View style={styles.feedHeader}>
                <Text style={styles.feedTitle}>Classroom Feed</Text>
                {pendingCount > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{pendingCount}</Text>
                  </View>
                ) : null}
              </View>

              {feedData.length === 0 ? (
                <Animated.View entering={FadeIn.duration(400)} style={styles.emptyState}>
                  <Ionicons name="document-text-outline" size={40} color={Colors.textDark} />
                  <Text style={styles.emptyTitle}>No observations yet</Text>
                  <Text style={styles.emptySubtitle}>
                    Observations will appear here after recording
                  </Text>
                </Animated.View>
              ) : (
                <FlatList
                  data={feedData}
                  renderItem={renderFeedItem}
                  keyExtractor={(item) => item.id}
                  contentContainerStyle={styles.feedContent}
                  showsVerticalScrollIndicator={false}
                />
              )}
            </View>

            {/* RIGHT PANEL — composer */}
            <View style={styles.rightPanel}>
              <View style={styles.tabRow}>
                <TouchableOpacity
                  style={[styles.tab, activeTab === "voice" && styles.tabActive]}
                  activeOpacity={0.75}
                  onPress={() => {
                    setActiveTab("voice");
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                >
                  <Ionicons
                    name="mic"
                    size={18}
                    color={activeTab === "voice" ? Colors.text : Colors.textMuted}
                  />
                  <Text style={[styles.tabText, activeTab === "voice" && styles.tabTextActive]}>
                    Voice
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.tab, activeTab === "photo" && styles.tabActive]}
                  activeOpacity={0.75}
                  onPress={() => {
                    setActiveTab("photo");
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                >
                  <Ionicons
                    name="camera"
                    size={18}
                    color={activeTab === "photo" ? Colors.text : Colors.textMuted}
                  />
                  <Text style={[styles.tabText, activeTab === "photo" && styles.tabTextActive]}>
                    Photo
                  </Text>
                </TouchableOpacity>
              </View>

              {activeTab === "voice" ? (
                <VoiceRecorder
                  classChildren={children}
                  classroomId={classroomId!}
                  onQueued={handleQueued}
                  isOnline={isOnline}
                />
              ) : (
                <PhotoRecorder
                  onQueued={handleQueued}
                  isOnline={isOnline}
                />
              )}
            </View>
          </View>

          <EditAttendanceModal
            child={editingChild}
            events={editingChildEvents}
            onClose={() => setEditingChild(null)}
            onSave={handleSaveEventTime}
            onDelete={handleDeleteEvent}
          />

          <Modal visible={!!editingObs} animationType="fade" transparent>
            <View style={styles.modalOverlay}>
              <View style={styles.modalBox}>
                <Text style={styles.modalTitle}>Edit Observation</Text>
                <TextInput
                  style={styles.modalInput}
                  value={editText}
                  onChangeText={setEditText}
                  multiline
                  autoFocus
                />
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={styles.modalCancelBtn}
                    onPress={() => setEditingObs(null)}
                  >
                    <Text style={styles.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.modalSaveBtn} onPress={handleSaveEdit}>
                    <Text style={styles.modalSaveText}>Save</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>
        </>
      )}

      {/* CHILDREN TAB */}
      {activeMainTab === 'children' && (
        <View style={mainTabStyles.screen}>
          <Text style={mainTabStyles.screenTitle}>Children</Text>
          {children.length === 0 ? (
            <Animated.View entering={FadeIn.duration(400)} style={styles.emptyState}>
              <Ionicons name="people-outline" size={40} color={Colors.textDark} />
              <Text style={styles.emptyTitle}>No children yet</Text>
            </Animated.View>
          ) : (
            <FlatList
              data={children}
              renderItem={({ item, index }) => (
                <ChildCard child={item} index={index} onPress={() => setSelectedChild(item)} />
              )}
              keyExtractor={(item) => item.id}
              numColumns={2}
              columnWrapperStyle={mainTabStyles.childrenGridRow}
              contentContainerStyle={mainTabStyles.childrenGridContent}
              showsVerticalScrollIndicator={false}
            />
          )}
          <ChildProfileModal
            child={selectedChild}
            classroomId={classroomId ?? ''}
            onClose={() => setSelectedChild(null)}
          />
        </View>
      )}

      {/* PLAN TAB */}
      {activeMainTab === 'plan' && (
        <PlanTab classroomId={classroomId ?? ''} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  panels: {
    flex: 1,
    flexDirection: "row",
  },
  // LEFT PANEL
  leftPanel: {
    width: 220,
    backgroundColor: Colors.surfaceAlt,
    borderRightWidth: 1,
    borderRightColor: Colors.background,
    paddingTop: 16,
  },
  leftHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  leftHeaderTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  classroomDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.success,
    flexShrink: 0,
  },
  classroomName: {
    fontSize: 15,
    fontFamily: "Nunito_700Bold",
    color: Colors.text,
    flexShrink: 1,
  },
  logoutBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  gridContent: {
    paddingHorizontal: 10,
    paddingBottom: 16,
    gap: 8,
  },
  gridRow: {
    gap: 8,
  },
  // MIDDLE PANEL
  middlePanel: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  feedHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
  },
  feedTitle: {
    fontSize: 18,
    fontFamily: "Nunito_700Bold",
    color: Colors.text,
  },
  feedContent: {
    paddingHorizontal: 16,
    paddingBottom: 20,
    gap: 10,
  },
  badge: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  badgeText: {
    fontSize: 12,
    fontFamily: "Nunito_700Bold",
    color: "#FFFFFF",
  },
  // RIGHT PANEL
  rightPanel: {
    width: 260,
    backgroundColor: Colors.surface,
    borderLeftWidth: 1,
    borderLeftColor: Colors.background,
    padding: 16,
    gap: 16,
  },
  // Shared
  childCard: {
    flex: 1,
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: 10,
    alignItems: "center",
    gap: 6,
    minHeight: 88,
    justifyContent: "center",
  },
  childAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  childInitials: {
    fontSize: 15,
    fontFamily: "Nunito_700Bold",
    color: "#FFFFFF",
  },
  childName: {
    fontSize: 12,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.text,
    textAlign: "center",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 24,
  },
  emptyTitle: {
    fontSize: 16,
    fontFamily: "Nunito_700Bold",
    color: Colors.textMuted,
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 13,
    fontFamily: "Nunito_400Regular",
    color: Colors.textDark,
    textAlign: "center",
  },
  // Tabs (right panel)
  tabRow: {
    flexDirection: "row",
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: 4,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    borderRadius: 10,
  },
  tabActive: {
    backgroundColor: Colors.surfaceAlt,
  },
  tabText: {
    fontSize: 14,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.textMuted,
  },
  tabTextActive: {
    color: Colors.text,
  },
  // Recorder
  recordArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingBottom: 8,
  },
  transcriptText: {
    fontSize: 13,
    fontFamily: "Nunito_400Regular",
    color: Colors.textMuted,
    textAlign: "center",
    lineHeight: 19,
    paddingHorizontal: 8,
  },
  recordBtn: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  recordHint: {
    fontSize: 14,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.textMuted,
  },
  hintError: {
    color: Colors.error,
  },
  // Edit modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  modalBox: {
    backgroundColor: Colors.surface,
    borderRadius: 20,
    padding: 24,
    width: 480,
    gap: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: "Nunito_700Bold",
    color: Colors.text,
  },
  modalInput: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    fontFamily: "Nunito_400Regular",
    color: Colors.text,
    minHeight: 120,
    textAlignVertical: "top",
  },
  modalActions: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "flex-end",
  },
  modalCancelBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: Colors.background,
  },
  modalCancelText: {
    fontSize: 15,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.textMuted,
  },
  modalSaveBtn: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: Colors.primary,
  },
  modalSaveText: {
    fontSize: 15,
    fontFamily: "Nunito_700Bold",
    color: "#FFFFFF",
  },
});

const attendanceStyles = StyleSheet.create({
  leftTabRow: {
    flexDirection: 'row',
    marginHorizontal: 10,
    marginBottom: 10,
    backgroundColor: Colors.background,
    borderRadius: 10,
    padding: 3,
  },
  leftTab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    borderRadius: 8,
  },
  leftTabActive: {
    backgroundColor: Colors.primary,
  },
  leftTabText: {
    fontSize: 12,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.textMuted,
  },
  leftTabTextActive: {
    color: '#FFFFFF',
  },
  moonBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    zIndex: 1,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  eventLabel: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.text,
  },
  eventTimeInput: {
    backgroundColor: Colors.background,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    fontFamily: 'Nunito_400Regular',
    color: Colors.text,
    width: 64,
    textAlign: 'center',
  },
  eventDeleteBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noEventsText: {
    fontSize: 14,
    fontFamily: 'Nunito_400Regular',
    color: Colors.textMuted,
  },
});

const feedStyles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  cardPending: {
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardChildName: {
    fontSize: 14,
    fontFamily: "Nunito_700Bold",
    color: Colors.text,
  },
  cardTimestamp: {
    fontSize: 12,
    fontFamily: "Nunito_400Regular",
    color: Colors.textMuted,
  },
  cardContent: {
    fontSize: 13,
    fontFamily: "Nunito_400Regular",
    color: Colors.text,
    lineHeight: 19,
  },
  cardPhoto: {
    width: "100%",
    height: 160,
    borderRadius: 10,
  },
  tagsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  tag: {
    backgroundColor: Colors.tagBg,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagText: {
    fontSize: 11,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.tagText,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
    paddingTop: 2,
  },
  approveBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: Colors.primary,
    borderRadius: 8,
    paddingVertical: 7,
  },
  editBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    backgroundColor: "#E07A6B",
    borderRadius: 8,
    paddingVertical: 7,
  },
  deleteBtn: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#C0392B",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  actionBtnText: {
    fontSize: 12,
    fontFamily: "Nunito_600SemiBold",
    color: "#FFFFFF",
  },
  structuredBox: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  structuredRow: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 4,
  },
  structuredLabel: {
    fontSize: 11,
    fontWeight: "bold",
    color: Colors.textMuted,
  },
  structuredValue: {
    fontSize: 12,
    color: Colors.textDark,
    flexShrink: 1,
  },
  recordBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  recordBadgeText: {
    fontSize: 10,
    fontWeight: "bold",
    color: "#FFFFFF",
  },
});

const placeholderStyles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  cardFailed: {
    backgroundColor: "#2D1515",
    borderWidth: 1,
    borderColor: "#C0392B",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  label: {
    fontSize: 13,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.textMuted,
  },
  labelFailed: {
    color: "#E07A6B",
  },
  subText: {
    fontSize: 12,
    fontFamily: "Nunito_400Regular",
    color: Colors.textDark,
  },
  retryBtn: {
    alignSelf: "flex-start",
    backgroundColor: "#C0392B",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  retryBtnText: {
    fontSize: 13,
    fontFamily: "Nunito_600SemiBold",
    color: "#FFFFFF",
  },
});

const cameraStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  camera: {
    flex: 1,
  },
  preview: {
    flex: 1,
  },
  controls: {
    position: "absolute",
    bottom: 48,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 40,
  },
  cancelBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 4,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#FFFFFF",
  },
  previewControls: {
    position: "absolute",
    bottom: 48,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
    paddingHorizontal: 32,
  },
  retakeBtn: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
  },
  retakeBtnText: {
    fontSize: 16,
    fontFamily: "Nunito_600SemiBold",
    color: "#FFFFFF",
  },
  usePhotoBtn: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 16,
    backgroundColor: Colors.success,
    alignItems: "center",
  },
  usePhotoBtnText: {
    fontSize: 16,
    fontFamily: "Nunito_700Bold",
    color: "#FFFFFF",
  },
});

const mainTabStyles = StyleSheet.create({
  tabBar: {
    flexDirection: "row",
    backgroundColor: Colors.surface,
    borderTopWidth: 0,
    paddingHorizontal: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 4,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    borderBottomColor: Colors.primary,
  },
  tabText: {
    fontSize: 14,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.textMuted,
  },
  tabTextActive: {
    color: Colors.primary,
  },
  screen: {
    flex: 1,
  },
  screenTitle: {
    fontSize: 22,
    fontFamily: "Nunito_700Bold",
    color: Colors.text,
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  childrenGridRow: {
    gap: 12,
    paddingHorizontal: 16,
  },
  childrenGridContent: {
    padding: 16,
    gap: 12,
  },
  childCardWrapper: {
    flex: 1,
  },
});

const profileStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
  },
  sheet: {
    width: '72%',
    backgroundColor: Colors.background,
    marginVertical: 32,
    borderRadius: 16,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerInitials: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  headerName: {
    flex: 1,
    fontSize: 18,
    fontFamily: 'Nunito_700Bold',
    color: Colors.text,
  },
  closeBtn: {
    padding: 4,
  },
  windowRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  windowBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  windowBtnActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  windowBtnText: {
    fontSize: 13,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.textMuted,
  },
  windowBtnTextActive: {
    color: '#FFFFFF',
  },
  loadingBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: 20,
    gap: 24,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Nunito_700Bold',
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  sectionEmpty: {
    fontSize: 13,
    color: Colors.textDark,
    fontStyle: 'italic',
    paddingLeft: 4,
  },
  obsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 10,
  },
  obsRowText: {
    flex: 1,
    gap: 4,
  },
  obsContent: {
    fontSize: 13,
    color: Colors.text,
    lineHeight: 18,
  },
  obsDate: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  obsThumb: {
    width: 52,
    height: 52,
    borderRadius: 6,
  },
  snapshotSection: {
    gap: 12,
  },
  generateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  generateBtnText: {
    fontSize: 14,
    fontFamily: 'Nunito_700Bold',
    color: '#FFFFFF',
  },
  snapshotLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
  },
  snapshotLoadingText: {
    fontSize: 14,
    color: Colors.textMuted,
  },
  snapshotCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  snapshotText: {
    fontSize: 14,
    color: Colors.text,
    lineHeight: 21,
  },
  snapshotActions: {
    flexDirection: 'row',
    gap: 10,
  },
  certifyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.success,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  certifyBtnText: {
    fontSize: 13,
    fontFamily: 'Nunito_700Bold',
    color: '#FFFFFF',
  },
  dismissBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  dismissBtnText: {
    fontSize: 13,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.textMuted,
  },
});

const planStyles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  screenContent: {
    paddingBottom: 40,
  },
  section: {
    paddingHorizontal: 24,
    paddingTop: 20,
    gap: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    fontSize: 15,
    fontFamily: 'Nunito_700Bold',
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  loadingIndicator: {
    marginTop: 12,
    alignSelf: 'flex-start',
  },
  gapWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.warningLight,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  gapWarningText: {
    fontSize: 13,
    fontFamily: 'Nunito_600SemiBold',
    color: '#F5A623',
  },
  foundationGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  foundationCard: {
    flex: 1,
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 12,
    padding: 14,
    gap: 4,
    opacity: 0.5,
  },
  foundationCardActive: {
    backgroundColor: Colors.primaryLight,
    opacity: 1,
  },
  foundationCount: {
    fontSize: 24,
    fontFamily: 'Nunito_700Bold',
    color: Colors.text,
  },
  foundationLabel: {
    fontSize: 12,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.textMuted,
    marginBottom: 6,
  },
  foundationBarBg: {
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    overflow: 'hidden',
  },
  foundationBarFill: {
    height: 4,
    borderRadius: 2,
  },
  generateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  generateBtnText: {
    fontSize: 13,
    fontFamily: 'Nunito_700Bold',
    color: '#FFFFFF',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: 'Nunito_400Regular',
    color: Colors.textMuted,
  },
  errorText: {
    fontSize: 14,
    fontFamily: 'Nunito_400Regular',
    color: Colors.error,
    paddingVertical: 8,
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Nunito_700Bold',
    color: Colors.text,
  },
  cardDescription: {
    fontSize: 14,
    fontFamily: 'Nunito_400Regular',
    color: Colors.textMuted,
    lineHeight: 20,
  },
  cardPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  pill: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillText: {
    fontSize: 12,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.textMuted,
  },
  hdlhPill: {
    backgroundColor: Colors.primaryLight,
  },
  hdlhPillText: {
    fontSize: 12,
    fontFamily: 'Nunito_600SemiBold',
    color: Colors.primary,
  },
  statusPill: {
    backgroundColor: Colors.surfaceAlt,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusPillDone: {
    backgroundColor: Colors.successLight,
  },
  statusPillSkipped: {
    backgroundColor: Colors.border,
  },
  statusPillText: {
    fontSize: 12,
    fontFamily: 'Nunito_700Bold',
    color: Colors.text,
  },
  cardRationale: {
    fontSize: 12,
    fontFamily: 'Nunito_400Regular',
    color: Colors.textDark,
    fontStyle: 'italic',
    lineHeight: 18,
  },
});
