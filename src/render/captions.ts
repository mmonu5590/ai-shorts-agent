/**
 * Burned-in captions.
 *
 * Most Shorts are watched with the sound off, so the transcript the pipeline
 * already produces is worth more on screen than it is in a JSON file. Cues are
 * cut to the clip's range and rebased to clip-relative time, written as SRT,
 * and burned in by libass through ffmpeg's `subtitles` filter.
 */

import type { Clip } from "../plan/types.ts";
import type { Transcript, TranscriptSegment, TranscriptWord } from "../transcribe/types.ts";

export interface CaptionCue {
  /** Seconds from the start of the clip. */
  start: number;
  end: number;
  text: string;
}

export interface CaptionStyle {
  /**
   * Cap height as a fraction of frame height.
   *
   * libass renders SRT against a virtual canvas 288 units tall, so the ASS
   * `FontSize` is that fraction of 288 rather than a pixel count.
   */
  fontSizeRatio: number;
  /** Distance from the bottom of the frame, as a fraction of frame height. */
  marginBottomRatio: number;
  /** Font family. Left unset by default so libass picks whatever is installed. */
  fontName?: string;
  /** `&HBBGGRR` — ASS colours are BGR, not RGB. */
  primaryColour: string;
  outlineColour: string;
  outlineWidth: number;
  bold: boolean;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSizeRatio: 0.055,
  marginBottomRatio: 0.12,
  primaryColour: "&H00FFFFFF",
  outlineColour: "&H00000000",
  outlineWidth: 3,
  bold: true,
};

export interface CueOptions {
  /** Words per cue when the transcript carries word timings. */
  maxWordsPerCue?: number;
  /** Longest a single cue may stay on screen. */
  maxCueSeconds?: number;
}

/** libass's virtual canvas height for SRT input; ASS font sizes are relative to it. */
const ASS_CANVAS_HEIGHT = 288;

function secondsToSrtTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  const millis = Math.round((clamped - whole) * 1000);
  const hh = String(Math.floor(whole / 3600)).padStart(2, "0");
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss},${String(millis).padStart(3, "0")}`;
}

/** Groups words into short cues, breaking on count or duration. */
function cuesFromWords(words: TranscriptWord[], options: Required<CueOptions>): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let batch: TranscriptWord[] = [];

  const flush = () => {
    if (batch.length === 0) return;
    cues.push({
      start: batch[0]!.start,
      end: batch.at(-1)!.end,
      text: batch.map((word) => word.text).join(" ").trim(),
    });
    batch = [];
  };

  for (const word of words) {
    batch.push(word);
    const span = batch.at(-1)!.end - batch[0]!.start;
    if (batch.length >= options.maxWordsPerCue || span >= options.maxCueSeconds) {
      flush();
    }
  }
  flush();

  return cues.filter((cue) => cue.text.length > 0 && cue.end > cue.start);
}

/** Every word in `segments`, in order. Empty when the provider gave none. */
function allWords(segments: TranscriptSegment[]): TranscriptWord[] {
  return segments.flatMap((segment) => segment.words ?? []);
}

/**
 * Builds the cues for one clip, in clip-relative time.
 *
 * Cues straddling a clip boundary are trimmed rather than dropped: the words
 * that fall inside the clip are the ones the viewer hears.
 */
export function clipCues(transcript: Transcript, clip: Clip, options: CueOptions = {}): CaptionCue[] {
  const resolved: Required<CueOptions> = {
    maxWordsPerCue: options.maxWordsPerCue ?? 5,
    maxCueSeconds: options.maxCueSeconds ?? 3,
  };

  const words = allWords(transcript.segments);
  const absolute =
    words.length > 0
      ? cuesFromWords(words, resolved)
      : // No word timings: fall back to whole segments, which is coarser but
        // still beats no captions at all.
        transcript.segments
          .filter((segment) => segment.text.trim().length > 0)
          .map((segment) => ({ start: segment.start, end: segment.end, text: segment.text.trim() }));

  const clipLength = clip.end - clip.start;

  return absolute
    .filter((cue) => cue.end > clip.start && cue.start < clip.end)
    .map((cue) => ({
      start: Math.max(0, cue.start - clip.start),
      end: Math.min(clipLength, cue.end - clip.start),
      text: cue.text,
    }))
    .filter((cue) => cue.end > cue.start);
}

/** Serialises cues as SRT. Returns an empty string when there is nothing to show. */
export function toSrt(cues: CaptionCue[]): string {
  if (cues.length === 0) return "";
  return (
    cues
      .map(
        (cue, index) =>
          `${index + 1}\n${secondsToSrtTime(cue.start)} --> ${secondsToSrtTime(cue.end)}\n${cue.text}`,
      )
      .join("\n\n") + "\n"
  );
}

/**
 * Escapes a path for use inside an ffmpeg filter graph.
 *
 * Backslashes, colons and single quotes all terminate or reinterpret filter
 * arguments, so a Windows path or a directory with a colon in it silently
 * builds the wrong graph without this.
 */
export function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** Builds the `subtitles` filter that burns `srtPath` into the frame. */
export function buildSubtitlesFilter(
  srtPath: string,
  style: CaptionStyle,
  frameHeight: number,
): string {
  const fontSize = Math.max(1, Math.round(style.fontSizeRatio * ASS_CANVAS_HEIGHT));
  const marginV = Math.max(0, Math.round(style.marginBottomRatio * ASS_CANVAS_HEIGHT));

  const forceStyle = [
    `FontSize=${fontSize}`,
    `PrimaryColour=${style.primaryColour}`,
    `OutlineColour=${style.outlineColour}`,
    `BorderStyle=1`,
    `Outline=${style.outlineWidth}`,
    `Shadow=0`,
    `Bold=${style.bold ? 1 : 0}`,
    // 2 is bottom-centre in ASS alignment numbering.
    `Alignment=2`,
    `MarginV=${marginV}`,
    ...(style.fontName ? [`FontName=${style.fontName}`] : []),
  ].join(",");

  // `original_size` tells libass the frame it is drawing into; without it the
  // margins are computed against the wrong canvas.
  return `subtitles=filename='${escapeFilterPath(srtPath)}':original_size=${Math.round(
    (frameHeight * 9) / 16,
  )}x${frameHeight}:force_style='${forceStyle}'`;
}
