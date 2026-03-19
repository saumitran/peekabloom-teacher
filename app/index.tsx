import { useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  Pressable,
  ActivityIndicator,
  Platform,
} from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import Animated, { FadeInDown, FadeInUp } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import Colors from "@/constants/colors";
import { useClassroom } from "@/lib/classroom";
import { supabase } from "@/lib/supabase";

export default function ActivationScreen() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { classroomId, isLoading, setClassroom } = useClassroom();
  const insets = useSafeAreaInsets();

  const webTopInset = Platform.OS === "web" ? 67 : 0;
  const webBottomInset = Platform.OS === "web" ? 34 : 0;

  if (isLoading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + webTopInset }]}>
        <ActivityIndicator size="large" color={Colors.primary} />
        <StatusBar style="light" />
      </View>
    );
  }

  if (classroomId) {
    setTimeout(() => router.replace("/home"), 0);
    return null;
  }

  const handleActivate = async () => {
    if (!code.trim()) {
      setError("Please enter a classroom code.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const { data, error: supaError } = await supabase
        .from("classrooms")
        .select("id, name")
        .eq("activation_code", code.trim().toUpperCase())
        .single();

      if (supaError || !data) {
        setError("Invalid code. Check with your director.");
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        }
      } else {
        await setClassroom(data.id, data.name);
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        router.replace("/home");
      }
    } catch (e) {
      setError("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  };

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
      <View style={styles.content}>
        <Animated.View entering={FadeInUp.duration(600)} style={styles.logoArea}>
          <View style={styles.iconCircle}>
            <Ionicons name="flower-outline" size={48} color={Colors.primary} />
          </View>
          <Text style={styles.title}>Peekabloom</Text>
          <Text style={styles.subtitle}>Enter your classroom code</Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.duration(600).delay(200)} style={styles.formArea}>
          <TextInput
            style={[styles.input, error ? styles.inputError : null]}
            placeholder="CLASSROOM CODE"
            placeholderTextColor={Colors.textDark}
            value={code}
            onChangeText={(t) => {
              setCode(t.toUpperCase());
              if (error) setError("");
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!loading}
            returnKeyType="go"
            onSubmitEditing={handleActivate}
          />

          {error ? (
            <Animated.View entering={FadeInDown.duration(300)} style={styles.errorRow}>
              <Ionicons name="alert-circle" size={16} color={Colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </Animated.View>
          ) : null}

          <Pressable
            style={({ pressed }) => [
              styles.activateBtn,
              pressed && styles.activateBtnPressed,
              loading && styles.activateBtnDisabled,
            ]}
            onPress={handleActivate}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.activateBtnText}>Activate</Text>
            )}
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    width: "100%",
    maxWidth: 420,
    alignItems: "center",
    paddingHorizontal: 32,
    gap: 40,
  },
  logoArea: {
    alignItems: "center",
    gap: 12,
  },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: {
    fontSize: 36,
    fontFamily: "Nunito_800ExtraBold",
    color: Colors.primary,
    letterSpacing: 0.5,
  },
  subtitle: {
    fontSize: 17,
    fontFamily: "Nunito_400Regular",
    color: Colors.textMuted,
  },
  formArea: {
    width: "100%",
    gap: 16,
  },
  input: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 18,
    fontSize: 20,
    fontFamily: "Nunito_700Bold",
    color: Colors.text,
    textAlign: "center",
    letterSpacing: 4,
    borderWidth: 2,
    borderColor: Colors.border,
  },
  inputError: {
    borderColor: Colors.error,
  },
  errorRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  errorText: {
    fontSize: 14,
    fontFamily: "Nunito_600SemiBold",
    color: Colors.error,
  },
  activateBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 58,
  },
  activateBtnPressed: {
    backgroundColor: Colors.primary,
    transform: [{ scale: 0.98 }],
  },
  activateBtnDisabled: {
    opacity: 0.7,
  },
  activateBtnText: {
    fontSize: 18,
    fontFamily: "Nunito_700Bold",
    color: "#FFFFFF",
  },
});
