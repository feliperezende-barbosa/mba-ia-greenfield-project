export interface MediaMetadata {
  container: string | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  bit_rate: number | null;
  size_bytes: number | null;
}

export interface MediaProbeResult {
  durationSeconds: number | null;
  metadata: MediaMetadata;
}
