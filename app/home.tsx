import { useState, useEffect, useCallback } from "react";
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
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import Animated, { FadeIn, FadeInDown } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import Colors from "@/constants/colors";
import { useClassroom } from "@/lib/classroom";
import { supabase, type Child, type Observation } from "@/lib/supabase";

type RecordingTab = "voice" | "photo";

function ChildCard({ child, index }: { child: Child; index: number }) {
  const words = (child.name || "").trim().split(/\s+/);
  const initials = words.length >= 2
    ? (words[0][0] + words[words.length - 1][0]).toUpperCase()
    : (words[0]?.[0] || "?").toUpperCase();
  const bgColors = [
    "#F97B6B",
    "#7BC4A0",
    "#6BA3F9",
    "#F9C76B",
    "#B87BF9",
    "#F96BA3",
    "#6BF9C7",
    "#F9A36B",
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
          <Text style={styles.childInitials}>{initials.toUpperCase()}</Text>
        </View>
        <Text style={styles.childName} numberOfLines={1}>
          {child.name}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

export default function HomeScreen() {
  const { classroomId, classroomName, isLoading: classroomLoading, clearClassroom } = useClassroom();
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
    console.log("[Peekabloom] classroom_id from SecureStore:", classroomId);
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

      console.log("[Peekabloom] children query result:", JSON.stringify(childRes, null, 2));
      if (childRes.error) {
        console.error("[Peekabloom] children query error:", childRes.error);
      }
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
              style={[
                styles.tab,
                activeTab === "voice" && styles.tabActive,
              ]}
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
                style={[
                  styles.tabText,
                  activeTab === "voice" && styles.tabTextActive,
                ]}
              >
                Voice
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.tab,
                activeTab === "photo" && styles.tabActive,
              ]}
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
                style={[
                  styles.tabText,
                  activeTab === "photo" && styles.tabTextActive,
                ]}
              >
                Photo
              </Text>
            </Pressable>
          </View>

          <View style={styles.recordArea}>
            {activeTab === "voice" ? (
              <Pressable
                style={({ pressed }) => [
                  styles.recordBtn,
                  pressed && styles.recordBtnPressed,
                ]}
                onPress={() => {
                  if (Platform.OS !== "web") {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  }
                }}
              >
                <Ionicons name="mic" size={32} color="#FFFFFF" />
              </Pressable>
            ) : (
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
            )}
            <Text style={styles.recordHint}>
              {activeTab === "voice" ? "Hold to Record" : "Tap to Capture"}
            </Text>
          </View>
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
  recordBtnPressed: {
    backgroundColor: Colors.primaryDark,
    transform: [{ scale: 0.95 }],
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
    shadowOpacity: 0.6,
  },
  recordHint: {
    fontSize: 14,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.textMuted,
  },
});
