import { VIDEO_TITLE_MAX_LENGTH } from './videos.constants';

const FALLBACK_TITLE = 'Untitled video';

export function deriveTitle(filename: string): string {
  const extensionStart = filename.lastIndexOf('.');
  // A leading dot (".mp4") or no dot at all means there is no stem to strip.
  const stem =
    extensionStart > 0 ? filename.slice(0, extensionStart) : filename;
  const title = (stem.trim() || filename.trim()).slice(
    0,
    VIDEO_TITLE_MAX_LENGTH,
  );
  return title.trim() || FALLBACK_TITLE;
}
