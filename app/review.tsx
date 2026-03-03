import { useState, useEffect, useCallback } from "react";
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  FlatList,
  TextInput,
  ActivityIndicator,
  Platform,
  Alert,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeIn, FadeInDown, FadeOut } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import Colors from "@/constants/colors";
import { useClassroom } from "@/lib/classroom";
import { supabase, type Observation } from "@/lib/supabase";

interface ObservationWithChild extends Observation {
  children?: {
    name: string;
  };
}

function ObservationCard({
  obs,
  index,
  onUpdate,
  onDelete,
}: {
  obs: ObservationWithChild;
  index: number;
  onUpdate: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [text, setText] = useState(obs.observation_text);
  const childName = obs.children?.name || "Unknown";

  const handleBlur = () => {
    if (text !== obs.observation_text) {
      onUpdate(obs.id, text);
    }
  };

  const confirmDelete = () => {
    if (Platform.OS === "web") {
      if (window.confirm("Remove this observation?")) {
        onDelete(obs.id);
      }
    } else {
      Alert.alert("Remove Observation", "Are you sure?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => onDelete(obs.id),
        },
      ]);
    }
  };

  return (
    <Animated.View
      entering={FadeInDown.duration(300).delay(index * 60)}
      exiting={FadeOut.duration(200)}
    >
      <View style={styles.obsCard}>
        <View style={styles.obsHeader}>
          <View style={styles.obsChildRow}>
            <Ionicons name="person-circle" size={24} color={Colors.accent} />
            <Text style={styles.obsChildName}>{childName}</Text>
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.deleteBtn,
              pressed && { opacity: 0.6 },
            ]}
            onPress={confirmDelete}
          >
            <Ionicons name="trash-outline" size={20} color={Colors.error} />
          </Pressable>
        </View>
        <TextInput
          style={styles.obsTextInput}
          value={text}
          onChangeText={setText}
          onBlur={handleBlur}
          multiline
          textAlignVertical="top"
          placeholderTextColor={Colors.textDark}
          placeholder="Observation text..."
        />
        <Text style={styles.obsDate}>
          {new Date(obs.created_at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </Text>
      </View>
    </Animated.View>
  );
}

export default function ReviewScreen() {
  const { classroomId } = useClassroom();
  const insets = useSafeAreaInsets();
  const [observations, setObservations] = useState<ObservationWithChild[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  const fetchObservations = useCallback(async () => {
    if (!classroomId) return;
    try {
      const { data } = await supabase
        .from("observations")
        .select("*, children(name)")
        .eq("classroom_id", classroomId)
        .eq("status", "pending")
        .order("created_at", { ascending: false });

      if (data) setObservations(data);
    } catch (e) {
      console.error("Failed to fetch observations:", e);
    } finally {
      setLoading(false);
    }
  }, [classroomId]);

  useEffect(() => {
    fetchObservations();
  }, [fetchObservations]);

  const handleUpdate = async (id: string, text: string) => {
    await supabase
      .from("observations")
      .update({ observation_text: text })
      .eq("id", id);
  };

  const handleDelete = async (id: string) => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    setObservations((prev) => prev.filter((o) => o.id !== id));
    await supabase.from("observations").delete().eq("id", id);
  };

  const handleApproveAll = async () => {
    if (observations.length === 0) return;
    setApproving(true);
    try {
      const ids = observations.map((o) => o.id);
      await supabase
        .from("observations")
        .update({ status: "approved" })
        .in("id", ids);

      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.back();
    } catch (e) {
      console.error("Failed to approve:", e);
    } finally {
      setApproving(false);
    }
  };

  const renderObs = ({ item, index }: { item: ObservationWithChild; index: number }) => (
    <ObservationCard
      obs={item}
      index={index}
      onUpdate={handleUpdate}
      onDelete={handleDelete}
    />
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
        <Pressable
          style={({ pressed }) => [
            styles.backBtn,
            pressed && { opacity: 0.6 },
          ]}
          onPress={() => router.back()}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>Review Observations</Text>
        {observations.length > 0 ? (
          <Pressable
            style={({ pressed }) => [
              styles.approveAllBtn,
              pressed && styles.approveAllBtnPressed,
              approving && styles.approveAllBtnDisabled,
            ]}
            onPress={handleApproveAll}
            disabled={approving}
          >
            {approving ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <>
                <Ionicons name="checkmark-done" size={18} color="#FFFFFF" />
                <Text style={styles.approveAllText}>Approve All</Text>
              </>
            )}
          </Pressable>
        ) : (
          <View style={{ width: 120 }} />
        )}
      </View>

      {loading ? (
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : observations.length === 0 ? (
        <Animated.View entering={FadeIn.duration(400)} style={styles.centerContent}>
          <Ionicons name="leaf-outline" size={56} color={Colors.textDark} />
          <Text style={styles.emptyTitle}>Nothing to review yet</Text>
          <Pressable
            style={({ pressed }) => [
              styles.backToHomeBtn,
              pressed && styles.backToHomeBtnPressed,
            ]}
            onPress={() => router.back()}
          >
            <Text style={styles.backToHomeText}>Back to Classroom</Text>
          </Pressable>
        </Animated.View>
      ) : (
        <FlatList
          data={observations}
          renderItem={renderObs}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        />
      )}
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
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: "Nunito_700Bold",
    color: Colors.text,
  },
  approveAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Colors.accent,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minWidth: 120,
    justifyContent: "center",
  },
  approveAllBtnPressed: {
    backgroundColor: Colors.accentDark,
    transform: [{ scale: 0.97 }],
  },
  approveAllBtnDisabled: {
    opacity: 0.7,
  },
  approveAllText: {
    fontSize: 14,
    fontFamily: "Nunito_700Bold",
    color: "#FFFFFF",
  },
  centerContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  emptyTitle: {
    fontSize: 20,
    fontFamily: "Nunito_700Bold",
    color: Colors.textMuted,
  },
  backToHomeBtn: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    paddingHorizontal: 24,
    paddingVertical: 12,
    marginTop: 8,
  },
  backToHomeBtnPressed: {
    backgroundColor: Colors.surfaceLight,
    transform: [{ scale: 0.97 }],
  },
  backToHomeText: {
    fontSize: 15,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.text,
  },
  listContent: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 32,
    maxWidth: 800,
    alignSelf: "center",
    width: "100%",
  },
  obsCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  obsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  obsChildRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  obsChildName: {
    fontSize: 16,
    fontFamily: "Nunito_700Bold",
    color: Colors.text,
  },
  deleteBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  obsTextInput: {
    backgroundColor: Colors.background,
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    fontFamily: "Nunito_400Regular",
    color: Colors.text,
    minHeight: 72,
  },
  obsDate: {
    fontSize: 12,
    fontFamily: "Nunito_400Regular",
    color: Colors.textDark,
    alignSelf: "flex-end",
  },
});
