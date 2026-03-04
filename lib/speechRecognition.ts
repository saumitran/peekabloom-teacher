import { useEffect, useRef } from "react";

type SpeechResultEvent = { results?: Array<{ transcript: string }> };
type SpeechErrorEvent = { error: string; message: string };
type SpeechEventMap = {
  result: SpeechResultEvent;
  error: SpeechErrorEvent;
  end: undefined;
};

interface SpeechModule {
  ExpoSpeechRecognitionModule: {
    start(opts: { lang: string; continuous: boolean; interimResults: boolean }): void;
    stop(): void;
    requestPermissionsAsync(): Promise<{ granted: boolean }>;
  };
  useSpeechRecognitionEvent<K extends keyof SpeechEventMap>(
    event: K,
    listener: (e: SpeechEventMap[K]) => void,
  ): void;
}

let _module: SpeechModule | null = null;

try {
  _module = require("expo-speech-recognition") as SpeechModule;
} catch (e) {
  console.warn(
    "[Peekabloom] expo-speech-recognition native module not available in this environment.",
  );
}

export const speechRecognitionAvailable = _module !== null;

export const ExpoSpeechRecognitionModule =
  _module?.ExpoSpeechRecognitionModule ?? {
    start: () => {},
    stop: () => {},
    requestPermissionsAsync: async () => ({ granted: false }),
  };

function useStubSpeechRecognitionEvent(
  _event: string,
  _listener: (e: unknown) => void,
) {
  const listenerRef = useRef(_listener);
  useEffect(() => {
    listenerRef.current = _listener;
  });
  useEffect(() => {}, []);
}

export const useSpeechRecognitionEvent: SpeechModule["useSpeechRecognitionEvent"] =
  _module?.useSpeechRecognitionEvent ??
  (useStubSpeechRecognitionEvent as SpeechModule["useSpeechRecognitionEvent"]);
