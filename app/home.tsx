import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  FlatList,
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
import { supabase, type Child, type Observation } from "@/lib/supabase";
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

const QUEUE_STORAGE_KEY = 'peekabloom_queue';

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
    return items.map(q => q.status === 'processing' ? { ...q, status: 'queued' as const } : q);
  } catch (e) {
    console.error('[Peekabloom] Failed to load queue:', e);
    return [];
  }
}


function showOfflineAlert() {
  Alert.alert('WiFi Required', 'Please connect to WiFi to record updates.');
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

function ChildCard({ child, index }: { child: Child; index: number }) {
  const words = (child.name || "").trim().split(/\s+/);
  const initials =
    words.length >= 2
      ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
      : (words[0]?.[0] || "?").toUpperCase();
  const bgColors = [
    "#F97B6B", "#7BC4A0", "#6BA3F9", "#F9C76B",
    "#B87BF9", "#F96BA3", "#6BF9C7", "#F9A36B",
  ];
  const bg = bgColors[index % bgColors.length];

  return (
    <Animated.View entering={FadeInDown.duration(400).delay(index * 50)}>
      <TouchableOpacity
        style={styles.childCard}
        activeOpacity={0.75}
        onPress={() => {
          if (Platform.OS !== "web") {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }
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
  const [photoUri, setPhotoUri] = useState<string | null>(null);

  useEffect(() => {
    if (!obs.photo_url) return;
    if (obs.photo_url.startsWith("http")) {
      setPhotoUri(obs.photo_url);
    } else {
      supabase.storage
        .from("photos")
        .createSignedUrl(obs.photo_url, 3600)
        .then(({ data }) => {
          if (data?.signedUrl) setPhotoUri(data.signedUrl);
        });
    }
  }, [obs.photo_url]);

  const isPending = obs.status === "pending";
  const hdlhTags = Array.isArray(obs.hdlh_tags) ? obs.hdlh_tags : [];
  const electTags = Array.isArray(obs.elect_tags) ? obs.elect_tags : [];

  return (
    <View style={[feedStyles.card, isPending && feedStyles.cardPending]}>
      <View style={feedStyles.cardHeader}>
        <Text style={feedStyles.cardChildName}>{child?.name ?? "Unknown"}</Text>
        <Text style={feedStyles.cardTimestamp}>{formatTimestamp(obs.created_at)}</Text>
      </View>
      <Text style={feedStyles.cardContent}>{obs.parsed_content}</Text>
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
  isOnline,
}: {
  item: QueueItem;
  onRetry: () => void;
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
        <Text style={[placeholderStyles.label, isFailed && placeholderStyles.labelFailed]}>
          {isFailed ? "Failed to save" : !isOnline && item.status === "queued" ? "Waiting for connection" : "Processing..."}
        </Text>
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
          ? Colors.accent
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
    const parseResponse = await fetch(parseUrl!, {
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
        ? Colors.accent
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
          style={[styles.recordBtn, { backgroundColor: Colors.accent }]}
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
  const [activeTab, setActiveTab] = useState<RecordingTab>("voice");
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
      .select("id, child_id, classroom_id, parsed_content, hdlh_tags, elect_tags, photo_url, status, created_at")
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

  const feedData = useMemo<FeedItem[]>(
    () => [
      ...queue.map((q) => ({ ...q, _type: "placeholder" as const })),
      ...observations.map((o) => ({ ...o, _type: "observation" as const })),
    ],
    [queue, observations]
  );

  const renderChild = ({ item, index }: { item: Child; index: number }) => (
    <ChildCard child={item} index={index} />
  );

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

      <View style={styles.panels}>
        {/* LEFT PANEL — children grid */}
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

      {/* Edit modal */}
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
    backgroundColor: Colors.surface,
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
    backgroundColor: Colors.accent,
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
    backgroundColor: Colors.surfaceLight,
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

const feedStyles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  cardPending: {
    opacity: 0.6,
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
    backgroundColor: "#7BC4A0",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagText: {
    fontSize: 11,
    fontFamily: "Nunito_600SemiBold",
    color: "#FFFFFF",
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
    backgroundColor: "#7BC4A0",
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
    backgroundColor: Colors.accent,
    alignItems: "center",
  },
  usePhotoBtnText: {
    fontSize: 16,
    fontFamily: "Nunito_700Bold",
    color: "#FFFFFF",
  },
});
