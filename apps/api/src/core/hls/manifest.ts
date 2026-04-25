import { spawn } from "node:child_process";
import { config } from "../../config.js";

type SegmentInfo = {
  id: string;
  filePath: string;
  duration: number; // seconds
};

type SessionManifest = {
  sessionId: number;
  segments: SegmentInfo[];
  ended: boolean;
};

const manifests = new Map<number, SessionManifest>();

export function ensureSessionManifest(sessionId: number): SessionManifest {
  let manifest = manifests.get(sessionId);
  if (!manifest) {
    manifest = { sessionId, segments: [], ended: false };
    manifests.set(sessionId, manifest);
  }
  return manifest;
}

export function addSegment(sessionId: number, filePath: string, duration: number): SegmentInfo {
  const manifest = ensureSessionManifest(sessionId);
  const segment: SegmentInfo = {
    id: `seg_${manifest.segments.length + 1}`,
    filePath,
    duration,
  };
  manifest.segments.push(segment);
  return segment;
}

export function endSessionManifest(sessionId: number): void {
  const manifest = manifests.get(sessionId);
  if (manifest) {
    manifest.ended = true;
  }
}

export function getManifest(sessionId: number): SessionManifest | undefined {
  return manifests.get(sessionId);
}

export async function getSegmentDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const ffprobePath = config.ffmpegPath.replace(/ffmpeg/i, "ffprobe");
    const child = spawn(ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { stdio: ["ignore", "pipe", "ignore"] });

    let output = "";
    child.stdout.on("data", (d) => { output += String(d); });
    child.on("close", () => {
      const duration = parseFloat(output);
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 120);
    });
    child.on("error", () => resolve(120));
  });
}

export function generateM3u8(sessionId: number): string {
  const manifest = manifests.get(sessionId);
  if (!manifest) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-TARGETDURATION:120",
  ];

  for (const seg of manifest.segments) {
    lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
    lines.push(`/api/sessions/${sessionId}/hls/${seg.id}.ts`);
  }

  if (manifest.ended) {
    lines.push("#EXT-X-ENDLIST");
  }

  return lines.join("\n") + "\n";
}
