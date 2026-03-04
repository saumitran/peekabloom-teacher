import { useState, useEffect, useCallback, useRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  FlatList,
  ActivityIndicator,
  Platform,
  RefreshControl,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  FadeIn,
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import {
  startRecording as startAudioRecording,
  setAudioMode,
  requestMicPermission,
  type RecordingHandle,
} from "@/lib/audioRecorder";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import Colors from "@/constants/colors";
import { useClassroom } from "@/lib/classroom";
import { supabase, type Child } from "@/lib/supabase";

type RecordingTab = "voice" | "photo";
type VoiceStatus = "idle" | "recording" | "parsing" | "saved" | "error";

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
      <Pressable
        style={({ pressed }) => [
          styles.childCard,
          pressed && styles.childCardPressed,
        ]}
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
      </Pressable>
    </Animated.View>
  );
}

function VoiceRecorder({
  children,
  classroomId,
  onSaved,
}: {
  children: Child[];
  classroomId: string;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const recordingRef = useRef<RecordingHandle | null>(null);
  const transcriptRef = useRef("");

  const scale = useSharedValue(1);
  const animatedBtnStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  useSpeechRecognitionEvent("result", (event) => {
    const text = event.results?.[0]?.transcript || "";
    transcriptRef.current = text;
    setTranscript(text);
  });

  useSpeechRecognitionEvent("error", (event) => {
    console.warn("[Peekabloom] Speech recognition error:", event.error, event.message);
  });

  useSpeechRecognitionEvent("end", () => {
    // Recognition ended naturally; recording ref handles cleanup
  });

  const startPulse = () => {
    scale.value = withRepeat(
      withSequence(
        withTiming(1.12, { duration: 500 }),
        withTiming(1.0, { duration: 500 }),
      ),
      -1,
      false,
    );
  };

  const stopPulse = () => {
    cancelAnimation(scale);
    scale.value = withTiming(1, { duration: 150 });
  };

  const requestPermissions = async (): Promise<boolean> => {
    try {
      const micGranted = await requestMicPermission();
      if (!micGranted) {
        setErrorMsg("Microphone access is needed to record observations.");
        setStatus("error");
        return false;
      }
      if (Platform.OS !== "web") {
        const speechResult =
          await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!speechResult.granted) {
          setErrorMsg("Speech recognition access is needed for live transcription.");
          setStatus("error");
          return false;
        }
      }
      return true;
    } catch (e) {
      console.error("[Peekabloom] Permission error:", e);
      return false;
    }
  };

  const startRecording = async () => {
    if (status !== "idle") return;

    const permitted = await requestPermissions();
    if (!permitted) return;

    try {
      if (Platform.OS !== "web") {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }

      transcriptRef.current = "";
      setTranscript("");
      setErrorMsg("");
      setStatus("recording");
      startPulse();

      if (Platform.OS !== "web") {
        await setAudioMode(true);
        recordingRef.current = await startAudioRecording();
        ExpoSpeechRecognitionModule.start({
          lang: "en-US",
          interimResults: true,
          continuous: true,
        });
      }
    } catch (e) {
      console.error("[Peekabloom] Start recording error:", e);
      stopPulse();
      setStatus("error");
      setErrorMsg("Couldn't start recording. Try again.");
    }
  };

  const stopRecording = async () => {
    if (status !== "recording") return;

    try {
      stopPulse();
      setStatus("parsing");

      if (Platform.OS !== "web") {
        ExpoSpeechRecognitionModule.stop();
        if (recordingRef.current) {
          await recordingRef.current.stop();
          recordingRef.current = null;
        }
        await setAudioMode(false);
      }

      const finalTranscript = transcriptRef.current.trim();

      if (!finalTranscript) {
        setStatus("error");
        setErrorMsg("No speech detected. Try again.");
        return;
      }

      await parseAndSave(finalTranscript);
    } catch (e) {
      console.error("[Peekabloom] Stop recording error:", e);
      setStatus("error");
      setErrorMsg("Couldn't parse. Try again.");
    }
  };

  const parseAndSave = async (finalTranscript: string) => {
    const parseUrl = process.env.EXPO_PUBLIC_PARSING_API_URL;
    const parseKey = process.env.EXPO_PUBLIC_PARSING_API_KEY;

    if (!parseUrl || !parseKey) {
      setStatus("error");
      setErrorMsg("Parsing API not configured.");
      return;
    }

    try {
      const response = await fetch(parseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${parseKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transcript: finalTranscript,
          children: children.map((c) => ({ id: c.id, name: c.name })),
          classroom_id: classroomId,
          photo_url: null,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("[Peekabloom] Parse API error:", response.status, errText);
        setStatus("error");
        setErrorMsg("Couldn't parse. Try again.");
        return;
      }

      const data = await response.json();
      const observations: Array<{
        child_id: string;
        classroom_id: string;
        parsed_content: string;
        hdlh_tags: unknown;
        elect_tags: unknown;
        photo_url: string | null;
        status: string;
      }> = data.observations || [];

      if (observations.length === 0) {
        setStatus("error");
        setErrorMsg("Nothing was parsed. Try again.");
        return;
      }

      const rows = observations.map((obs) => ({
        child_id: obs.child_id,
        classroom_id: obs.classroom_id,
        raw_transcript: finalTranscript,
        parsed_content: obs.parsed_content,
        hdlh_tags: obs.hdlh_tags,
        elect_tags: obs.elect_tags,
        photo_url: obs.photo_url ?? null,
        status: obs.status || "pending",
      }));

      const { error: saveError } = await supabase
        .from("observations")
        .insert(rows);

      if (saveError) {
        console.error("[Peekabloom] Supabase save error:", saveError);
        setStatus("error");
        setErrorMsg("Couldn't save. Try again.");
        return;
      }

      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setStatus("saved");
      setTranscript("");
      transcriptRef.current = "";
      onSaved();

      setTimeout(() => {
        setStatus("idle");
        setErrorMsg("");
      }, 2000);
    } catch (e) {
      console.error("[Peekabloom] parseAndSave error:", e);
      setStatus("error");
      setErrorMsg("Couldn't parse. Try again.");
    }
  };

  const resetError = () => {
    setStatus("idle");
    setErrorMsg("");
    setTranscript("");
  };

  const isRecording = status === "recording";
  const isParsing = status === "parsing";
  const isSaved = status === "saved";
  const isError = status === "error";

  return (
    <View style={styles.recordArea}>
      {isRecording && transcript ? (
        <Animated.View entering={FadeIn.duration(200)} style={styles.transcriptBox}>
          <Text style={styles.transcriptText} numberOfLines={4}>
            {transcript}
          </Text>
        </Animated.View>
      ) : null}

      {isError ? (
        <Animated.View entering={FadeIn.duration(200)} style={styles.errorBox}>
          <Text style={styles.errorBoxText}>{errorMsg}</Text>
          <Pressable onPress={resetError} style={styles.retryBtn}>
            <Text style={styles.retryBtnText}>Try Again</Text>
          </Pressable>
        </Animated.View>
      ) : null}

      <Animated.View style={animatedBtnStyle}>
        <Pressable
          style={[
            styles.recordBtn,
            isRecording && styles.recordBtnActive,
            isSaved && styles.recordBtnSaved,
            isParsing && styles.recordBtnParsing,
          ]}
          onPressIn={startRecording}
          onPressOut={stopRecording}
          disabled={isParsing || isSaved || isError}
        >
          {isParsing ? (
            <ActivityIndicator color="#FFFFFF" size="large" />
          ) : isSaved ? (
            <Ionicons name="checkmark" size={36} color="#FFFFFF" />
          ) : (
            <Ionicons name="mic" size={32} color="#FFFFFF" />
          )}
        </Pressable>
      </Animated.View>

      <Text
        style={[
          styles.recordHint,
          isRecording && styles.recordHintActive,
          isSaved && styles.recordHintSaved,
        ]}
      >
        {isParsing
          ? "Parsing..."
          : isSaved
            ? "Saved"
            : isRecording
              ? "Recording..."
              : isError
                ? ""
                : "Hold to Record"}
      </Text>
    </View>
  );
}

export default function HomeScreen() {
  const { classroomId, classroomName, isLoading: classroomLoading, clearClassroom } =
    useClassroom();
  const insets = useSafeAreaInsets();
  const [children, setChildren] = useState<Child[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<RecordingTab>("voice");

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  const fetchData = useCallback(async () => {
    if (!classroomId) return;
    try {
      const [childRes, obsRes] = await Promise.all([
        supabase
          .from("children")
          .select("*")
          .eq("classroom_id", classroomId)
          .order("name"),
        supabase
          .from("observations")
          .select("id", { count: "exact" })
          .eq("classroom_id", classroomId)
          .eq("status", "pending"),
      ]);

      if (childRes.data) setChildren(childRes.data);
      setPendingCount(obsRes.count || 0);
    } catch (e) {
      console.error("[Peekabloom] Failed to fetch data:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [classroomId]);

  useEffect(() => {
    if (!classroomLoading && !classroomId) {
      router.replace("/");
      return;
    }
    fetchData();
  }, [classroomId, classroomLoading, fetchData]);

  const handleObservationSaved = useCallback(() => {
    setPendingCount((n) => n + 1);
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  if (classroomLoading || loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <StatusBar style="light" />
      </View>
    );
  }

  const renderChild = ({ item, index }: { item: Child; index: number }) => (
    <ChildCard child={item} index={index} />
  );

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top + webTopInset,
          paddingBottom: insets.bottom + webBottomInset,
        },
      ]}
    >
      <StatusBar style="light" />

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.classroomDot} />
          <Text style={styles.classroomName} numberOfLines={1}>
            {classroomName || "Classroom"}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <Pressable
            style={({ pressed }) => [
              styles.reviewBtn,
              pressed && styles.reviewBtnPressed,
            ]}
            onPress={() => {
              if (Platform.OS !== "web") {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }
              router.push("/review");
            }}
          >
            <Ionicons name="documents-outline" size={20} color={Colors.text} />
            <Text style={styles.reviewBtnText}>Review</Text>
            {pendingCount > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{pendingCount}</Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.logoutBtn,
              pressed && { opacity: 0.6 },
            ]}
            onPress={async () => {
              await clearClassroom();
              router.replace("/");
            }}
          >
            <Ionicons name="log-out-outline" size={22} color={Colors.textMuted} />
          </Pressable>
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.gridArea}>
          {children.length === 0 ? (
            <Animated.View entering={FadeIn.duration(400)} style={styles.emptyState}>
              <Ionicons name="people-outline" size={48} color={Colors.textDark} />
              <Text style={styles.emptyTitle}>No children yet</Text>
              <Text style={styles.emptySubtitle}>
                Children will appear here once added to this classroom
              </Text>
            </Animated.View>
          ) : (
            <FlatList
              data={children}
              renderItem={renderChild}
              keyExtractor={(item) => item.id}
              numColumns={4}
              columnWrapperStyle={styles.gridRow}
              contentContainerStyle={styles.gridContent}
              showsVerticalScrollIndicator={false}
              scrollEnabled={children.length > 0}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={Colors.primary}
                />
              }
            />
          )}
        </View>

        <View style={styles.recordingBar}>
          <View style={styles.tabRow}>
            <Pressable
              style={[styles.tab, activeTab === "voice" && styles.tabActive]}
              onPress={() => {
                setActiveTab("voice");
                if (Platform.OS !== "web") {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
              }}
            >
              <Ionicons
                name="mic"
                size={18}
                color={activeTab === "voice" ? Colors.text : Colors.textMuted}
              />
              <Text
                style={[styles.tabText, activeTab === "voice" && styles.tabTextActive]}
              >
                Voice
              </Text>
            </Pressable>
            <Pressable
              style={[styles.tab, activeTab === "photo" && styles.tabActive]}
              onPress={() => {
                setActiveTab("photo");
                if (Platform.OS !== "web") {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }
              }}
            >
              <Ionicons
                name="camera"
                size={18}
                color={activeTab === "photo" ? Colors.text : Colors.textMuted}
              />
              <Text
                style={[styles.tabText, activeTab === "photo" && styles.tabTextActive]}
              >
                Photo
              </Text>
            </Pressable>
          </View>

          {activeTab === "voice" ? (
            <VoiceRecorder
              children={children}
              classroomId={classroomId!}
              onSaved={handleObservationSaved}
            />
          ) : (
            <View style={styles.recordArea}>
              <Pressable
                style={({ pressed }) => [
                  styles.cameraBtn,
                  pressed && styles.cameraBtnPressed,
                ]}
                onPress={() => {
                  if (Platform.OS !== "web") {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  }
                }}
              >
                <Ionicons name="camera" size={32} color="#FFFFFF" />
              </Pressable>
              <Text style={styles.recordHint}>Tap to Capture</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  classroomDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.accent,
  },
  classroomName: {
    fontSize: 22,
    fontFamily: "Nunito_700Bold",
    color: Colors.text,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  reviewBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  reviewBtnPressed: {
    backgroundColor: Colors.surfaceLight,
    transform: [{ scale: 0.97 }],
  },
  reviewBtnText: {
    fontSize: 15,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.text,
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
  logoutBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    flexDirection: "row",
  },
  gridArea: {
    flex: 1,
    paddingHorizontal: 24,
  },
  gridContent: {
    paddingBottom: 24,
    gap: 12,
  },
  gridRow: {
    gap: 12,
  },
  childCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    gap: 10,
    minHeight: 110,
    justifyContent: "center",
  },
  childCardPressed: {
    backgroundColor: Colors.surfaceLight,
    transform: [{ scale: 0.97 }],
  },
  childAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  childInitials: {
    fontSize: 18,
    fontFamily: "Nunito_700Bold",
    color: "#FFFFFF",
  },
  childName: {
    fontSize: 14,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.text,
    textAlign: "center",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: "Nunito_700Bold",
    color: Colors.textMuted,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: "Nunito_400Regular",
    color: Colors.textDark,
    textAlign: "center",
    maxWidth: 280,
  },
  recordingBar: {
    width: 280,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24,
    borderBottomLeftRadius: 24,
    padding: 20,
    gap: 20,
  },
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
    paddingVertical: 10,
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
  recordArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingBottom: 8,
  },
  transcriptBox: {
    width: "100%",
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: 12,
    maxHeight: 96,
  },
  transcriptText: {
    fontSize: 13,
    fontFamily: "Nunito_400Regular",
    color: Colors.textMuted,
    lineHeight: 19,
  },
  errorBox: {
    width: "100%",
    backgroundColor: "rgba(255,107,107,0.12)",
    borderRadius: 12,
    padding: 12,
    alignItems: "center",
    gap: 8,
  },
  errorBoxText: {
    fontSize: 13,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.error,
    textAlign: "center",
  },
  retryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: Colors.surface,
    borderRadius: 8,
  },
  retryBtnText: {
    fontSize: 13,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.text,
  },
  recordBtn: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  recordBtnActive: {
    backgroundColor: Colors.primary,
    shadowOpacity: 0.7,
  },
  recordBtnParsing: {
    backgroundColor: Colors.textMuted,
    shadowOpacity: 0.2,
  },
  recordBtnSaved: {
    backgroundColor: Colors.accent,
    shadowColor: Colors.accent,
    shadowOpacity: 0.6,
  },
  cameraBtn: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Colors.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  cameraBtnPressed: {
    backgroundColor: Colors.accentDark,
    transform: [{ scale: 0.95 }],
  },
  recordHint: {
    fontSize: 14,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.textMuted,
  },
  recordHintActive: {
    color: Colors.primary,
  },
  recordHintSaved: {
    color: Colors.accent,
  },
});
