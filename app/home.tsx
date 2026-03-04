import { useState, useEffect, useCallback, useRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Platform,
  RefreshControl,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { Audio } from "expo-av";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  speechRecognitionAvailable,
} from "@/lib/speechRecognition";
import Colors from "@/constants/colors";
import { useClassroom } from "@/lib/classroom";
import { supabase, type Child } from "@/lib/supabase";

type RecordingTab = "voice" | "photo";
type UiState = "idle" | "recording" | "parsing" | "saved" | "error";

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

function VoiceRecorder({
  classChildren,
  classroomId,
  onSaved,
}: {
  classChildren: Child[];
  classroomId: string;
  onSaved: () => void;
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
      setIsRecording(false);
      setUiState("parsing");
      await parseAndSave(transcriptRef.current.trim());
    } catch (e) {
      console.error("[Peekabloom] Stop recording error:", e);
      setIsRecording(false);
      setUiState("error");
    }
  };

  const parseAndSave = async (finalTranscript: string) => {
    const parseUrl = process.env.EXPO_PUBLIC_PARSING_API_URL;
    const parseKey = process.env.EXPO_PUBLIC_PARSING_API_KEY;

    if (!finalTranscript) {
      setUiState("error");
      return;
    }

    try {
      const response = await fetch(parseUrl!, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${parseKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          transcript: finalTranscript,
          children: classChildren,
          classroom_id: classroomId,
          photo_url: null,
        }),
      });

      if (!response.ok) {
        console.error("[Peekabloom] Parse API error:", response.status);
        setUiState("error");
        return;
      }

      const data = await response.json();
      const observations = data.observations ?? [];

      if (observations.length === 0) {
        setUiState("error");
        return;
      }

      const rows = observations.map((obs: {
        child_id: string;
        classroom_id: string;
        parsed_content: string;
        hdlh_tags: unknown;
        elect_tags: unknown;
        photo_url: string | null;
        status: string;
      }) => ({
        child_id: obs.child_id,
        classroom_id: obs.classroom_id,
        raw_transcript: finalTranscript,
        parsed_content: obs.parsed_content,
        hdlh_tags: obs.hdlh_tags,
        elect_tags: obs.elect_tags,
        photo_url: obs.photo_url ?? null,
        status: obs.status ?? "pending",
      }));

      const { error: saveError } = await supabase
        .from("observations")
        .insert(rows);

      if (saveError) {
        console.error("[Peekabloom] Supabase save error:", saveError);
        setUiState("error");
        return;
      }

      setUiState("saved");
      setTranscript("");
      transcriptRef.current = "";
      onSaved();
      setTimeout(() => setUiState("idle"), 2000);
    } catch (e) {
      console.error("[Peekabloom] parseAndSave error:", e);
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
      : uiState === "parsing"
        ? "Parsing..."
        : uiState === "saved"
          ? "Saved"
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

export default function HomeScreen() {
  const {
    classroomId,
    classroomName,
    isLoading: classroomLoading,
    clearClassroom,
  } = useClassroom();
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

  try {
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
            <TouchableOpacity
              style={styles.reviewBtn}
              activeOpacity={0.75}
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
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.logoutBtn}
              activeOpacity={0.6}
              onPress={async () => {
                await clearClassroom();
                router.replace("/");
              }}
            >
              <Ionicons name="log-out-outline" size={22} color={Colors.textMuted} />
            </TouchableOpacity>
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
              <TouchableOpacity
                style={[styles.tab, activeTab === "voice" && styles.tabActive]}
                activeOpacity={0.75}
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
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tab, activeTab === "photo" && styles.tabActive]}
                activeOpacity={0.75}
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
              </TouchableOpacity>
            </View>

            {activeTab === "voice" ? (
              <VoiceRecorder
                classChildren={children}
                classroomId={classroomId!}
                onSaved={handleObservationSaved}
              />
            ) : (
              <View style={styles.recordArea}>
                <TouchableOpacity
                  style={[styles.recordBtn, { backgroundColor: Colors.accent }]}
                  activeOpacity={0.8}
                  onPress={() => {
                    if (Platform.OS !== "web") {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    }
                  }}
                >
                  <Ionicons name="camera" size={32} color="#FFFFFF" />
                </TouchableOpacity>
                <Text style={styles.recordHint}>Tap to Capture</Text>
              </View>
            )}
          </View>
        </View>
      </View>
    );
  } catch (e) {
    console.error("[Peekabloom] HomeScreen render error:", e);
    return (
      <View style={styles.container}>
        <Text style={{ color: Colors.text, padding: 24 }}>
          Render error: {String(e)}
        </Text>
      </View>
    );
  }
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
});
