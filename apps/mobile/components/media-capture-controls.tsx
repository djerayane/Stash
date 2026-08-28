import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { File } from "expo-file-system";
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";

import type { MobileCapture } from "@stash/domain-types";
import { NativeActionButton } from "@/components/native-controls";
import { stashTheme } from "@/theme/theme";
import { MAX_VOICE_DURATION_SECONDS, readBoundedOriginal } from "@/src/media-input";

type MediaInput = { kind: "photo" | "file" | "voice"; filename: string; contentType: string; base64: string };

export function MediaCaptureControls({ onPicked, onError }: {
  onPicked: (media: MediaInput) => Promise<MobileCapture>;
  onError: (message: string) => void;
}) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recording = useAudioRecorderState(recorder);
  const [busy, setBusy] = useState(false);
  const savedVoiceUri = useRef<string | undefined>(undefined);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await operation(); } catch (error) { onError(error instanceof Error ? error.message : "The original could not be saved."); }
    finally { setBusy(false); }
  };
  const queueFile = async (kind: MediaInput["kind"], uri: string, filename: string, contentType: string) => {
    await onPicked({ kind, filename, contentType, base64: await readBoundedOriginal(new File(uri)) });
  };
  const queueVoice = async () => {
    const uri = recorder.uri;
    if (!uri) throw new Error("The voice recording could not be read.");
    if (savedVoiceUri.current === uri) return;
    savedVoiceUri.current = uri;
    try { await queueFile("voice", uri, `voice-${Date.now()}.m4a`, "audio/mp4"); }
    catch (error) { savedVoiceUri.current = undefined; throw error; }
  };
  useEffect(() => {
    if (recording.isRecording || recording.durationMillis < MAX_VOICE_DURATION_SECONDS * 1_000 || !recorder.uri
      || savedVoiceUri.current === recorder.uri) return;
    void run(queueVoice);
  }, [recording.isRecording, recording.durationMillis, recorder.uri]);
  const choosePhoto = () => run(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error("Photo access was denied. Allow access in Settings to attach an original photo.");
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: false, quality: 1 });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) throw new Error("The selected photo is unavailable.");
    await queueFile("photo", asset.uri, asset.fileName ?? `photo-${Date.now()}.jpg`, asset.mimeType ?? "image/jpeg");
  });
  const chooseFile = () => run(async () => {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) throw new Error("The selected file is unavailable.");
    await queueFile("file", asset.uri, asset.name, asset.mimeType ?? "application/octet-stream");
  });
  const toggleRecording = () => run(async () => {
    if (recording.isRecording) {
      await recorder.stop();
      await queueVoice();
      return;
    }
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error("Microphone access was denied. Allow access in Settings to capture voice.");
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: MAX_VOICE_DURATION_SECONDS });
  });
  return <View accessibilityRole="summary" accessibilityLabel="Add original media" style={{ gap: stashTheme.spacing.sm }}>
    <Text selectable style={{ color: stashTheme.colors.secondaryInk, lineHeight: 20 }}>Original photos, files, and voice stay encrypted here until they reach your Workspace. Voice stops after five minutes.</Text>
    <NativeActionButton variant="secondary" label="Choose photo" disabled={busy || recording.isRecording} onPress={choosePhoto} />
    <NativeActionButton variant="secondary" label="Choose file" disabled={busy || recording.isRecording} onPress={chooseFile} />
    <NativeActionButton variant="secondary" label={recording.isRecording ? "Stop and save voice" : "Record voice"} disabled={busy} onPress={toggleRecording} />
  </View>;
}
