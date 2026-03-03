import { createContext, useContext, useState, useEffect, useMemo, ReactNode } from "react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

interface ClassroomContextValue {
  classroomId: string | null;
  classroomName: string | null;
  isLoading: boolean;
  setClassroom: (id: string, name: string) => Promise<void>;
  clearClassroom: () => Promise<void>;
}

const ClassroomContext = createContext<ClassroomContextValue | null>(null);

const CLASSROOM_ID_KEY = "peekabloom_classroom_id";
const CLASSROOM_NAME_KEY = "peekabloom_classroom_name";

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    return localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function deleteItem(key: string): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export function ClassroomProvider({ children }: { children: ReactNode }) {
  const [classroomId, setClassroomId] = useState<string | null>(null);
  const [classroomName, setClassroomName] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const id = await getItem(CLASSROOM_ID_KEY);
        const name = await getItem(CLASSROOM_NAME_KEY);
        if (id && name) {
          setClassroomId(id);
          setClassroomName(name);
        }
      } catch (e) {
        console.error("Failed to load classroom:", e);
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  const setClassroom = async (id: string, name: string) => {
    await setItem(CLASSROOM_ID_KEY, id);
    await setItem(CLASSROOM_NAME_KEY, name);
    setClassroomId(id);
    setClassroomName(name);
  };

  const clearClassroom = async () => {
    await deleteItem(CLASSROOM_ID_KEY);
    await deleteItem(CLASSROOM_NAME_KEY);
    setClassroomId(null);
    setClassroomName(null);
  };

  const value = useMemo(
    () => ({ classroomId, classroomName, isLoading, setClassroom, clearClassroom }),
    [classroomId, classroomName, isLoading],
  );

  return <ClassroomContext.Provider value={value}>{children}</ClassroomContext.Provider>;
}

export function useClassroom() {
  const context = useContext(ClassroomContext);
  if (!context) {
    throw new Error("useClassroom must be used within a ClassroomProvider");
  }
  return context;
}
