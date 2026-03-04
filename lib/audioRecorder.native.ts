import { Audio } from "expo-av";

export type RecordingHandle = {
  stop: () => Promise<void>;
};

export async function setAudioMode(allowRecording: boolean) {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: allowRecording,
    playsInSilentModeIOS: true,
  });
}

export async function startRecording(): Promise<RecordingHandle> {
  const { recording } = await Audio.Recording.createAsync(
    Audio.RecordingOptionsPresets.HIGH_QUALITY,
  );

  return {
    stop: async () => {
      await recording.stopAndUnloadAsync();
    },
  };
}

export async function requestMicPermission(): Promise<boolean> {
  const result = await Audio.requestPermissionsAsync();
  return result.granted;
}
