export type RecordingHandle = {
  stop: () => Promise<void>;
};

export async function setAudioMode(_allowRecording: boolean) {}

export async function startRecording(): Promise<RecordingHandle> {
  return { stop: async () => {} };
}

export async function requestMicPermission(): Promise<boolean> {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch {
    return false;
  }
}
