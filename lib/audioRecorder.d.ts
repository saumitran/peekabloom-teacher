export type RecordingHandle = {
  stop: () => Promise<void>;
};
export declare function setAudioMode(allowRecording: boolean): Promise<void>;
export declare function startRecording(): Promise<RecordingHandle>;
export declare function requestMicPermission(): Promise<boolean>;
