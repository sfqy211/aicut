import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { eventBus } from "../../events/bus.js";

export type ClipExportOptions = {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  durationSeconds: number;
};

export type MultiClipExportOptions = {
  clips: Array<{
    inputPath: string;
    startSeconds: number;
    durationSeconds: number;
  }>;
  outputPath: string;
  onProgress?: (percent: number) => void;
};

export type ExportOptions = {
  hardcodeSubtitles?: boolean;
  hardcodeDanmaku?: boolean;
  quality?: "original" | "1080p" | "720p";
  format?: "mp4" | "webm";
};

// 导出单个片段
export function exportClip(options: ClipExportOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-ss",
      String(options.startSeconds),
      "-i",
      options.inputPath,
      "-t",
      String(options.durationSeconds),
      "-c",
      "copy",
      options.outputPath,
    ];

    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `FFmpeg exited with code ${code}`));
      }
    });
  });
}

// 合并多个片段
export function exportMultiClips(options: MultiClipExportOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const { clips, outputPath, onProgress } = options;

    if (clips.length === 0) {
      reject(new Error("No clips to export"));
      return;
    }

    if (clips.length === 1) {
      const clip = clips[0];
      if (!clip) {
        reject(new Error("Invalid clip"));
        return;
      }
      exportClip({
        inputPath: clip.inputPath,
        outputPath,
        startSeconds: clip.startSeconds,
        durationSeconds: clip.durationSeconds,
      })
        .then(resolve)
        .catch(reject);
      return;
    }

    // 创建临时 concat 文件
    const tempDir = path.dirname(outputPath);
    const concatFile = path.join(tempDir, `concat_${Date.now()}.txt`);

    // 准备裁剪后的临时文件
    const tempFiles: string[] = [];
    let completed = 0;

    const cleanup = () => {
      for (const file of tempFiles) {
        try {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch {
          // ignore
        }
      }
      try {
        if (fs.existsSync(concatFile)) fs.unlinkSync(concatFile);
      } catch {
        // ignore
      }
    };

    // 先裁剪每个片段
    const trimPromises = clips.map((clip, index) => {
      const tempFile = path.join(tempDir, `clip_${index}_${Date.now()}.ts`);
      tempFiles.push(tempFile);

      return new Promise<void>((res, rej) => {
        const args = [
          "-y",
          "-ss",
          String(clip.startSeconds),
          "-i",
          clip.inputPath,
          "-t",
          String(clip.durationSeconds),
          "-c",
          "copy",
          "-bsf:v",
          "h264_mp4toannexb",
          "-f",
          "mpegts",
          tempFile,
        ];

        const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";

        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });

        child.on("error", rej);
        child.on("close", (code) => {
          if (code === 0) {
            completed++;
            onProgress?.(Math.round((completed / clips.length) * 50));
            res();
          } else {
            rej(new Error(stderr || `FFmpeg exited with code ${code}`));
          }
        });
      });
    });

    Promise.all(trimPromises)
      .then(() => {
        // 写入 concat 文件
        const concatContent = tempFiles.map((f) => `file '${f}'`).join("\n");
        fs.writeFileSync(concatFile, concatContent);

        // 合并
        return new Promise<void>((res, rej) => {
          const args = [
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            concatFile,
            "-c",
            "copy",
            outputPath,
          ];

          const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";

          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });

          child.on("error", rej);
          child.on("close", (code) => {
            if (code === 0) {
              onProgress?.(100);
              res();
            } else {
              rej(new Error(stderr || `FFmpeg exited with code ${code}`));
            }
          });
        });
      })
      .then(() => {
        cleanup();
        resolve();
      })
      .catch((err) => {
        cleanup();
        reject(err);
      });
  });
}

// 生成 SRT 字幕文件
export function generateSrt(
  outputPath: string,
  segments: Array<{ start: number; end: number; text: string }>
): void {
  const lines: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;

    lines.push(String(i + 1));
    lines.push(`${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}`);
    lines.push(seg.text);
    lines.push("");
  }

  fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

// 生成片段预览（低码率）
export function generatePreview(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-ss",
      String(startSeconds),
      "-i",
      inputPath,
      "-t",
      String(durationSeconds),
      "-vf",
      "scale=640:-2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-f",
      "mp4",
      outputPath,
    ];

    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `FFmpeg exited with code ${code}`));
      }
    });
  });
}

// 导出任务处理器
export async function processExportTask(exportId: number): Promise<void> {
  const { getDb, row } = await import("../../db/index.js");

  const db = getDb();
  const exportJob = row<{
    id: number;
    session_id: number;
    candidate_ids: string;
    output_path: string | null;
    options_json: string | null;
  }>(db.prepare("SELECT * FROM exports WHERE id = ?"), exportId);

  if (!exportJob) {
    throw new Error(`Export ${exportId} not found`);
  }

  const options: ExportOptions = exportJob.options_json
    ? JSON.parse(exportJob.options_json)
    : {};

  const candidateIds = JSON.parse(exportJob.candidate_ids) as number[];

  // 获取候选片段信息
  const candidates = db
    .prepare(
      `SELECT c.id, c.start_time, c.end_time, c.duration, c.segment_id,
              seg.file_path AS segment_file_path
       FROM candidates c
       LEFT JOIN segments seg ON seg.id = c.segment_id
       WHERE c.id IN (${candidateIds.map(() => "?").join(",")})
       ORDER BY c.start_time ASC`
    )
    .all(...candidateIds) as Array<{
    id: number;
    start_time: number;
    end_time: number;
    duration: number;
    segment_id: number | null;
    segment_file_path: string | null;
  }>;

  if (candidates.length === 0) {
    throw new Error("No valid candidates found");
  }

  // 确定输出路径
  const sessionDir = path.join(config.libraryRoot, "exports");
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = `export_${exportJob.session_id}_${timestamp}`;
  const format = options.format ?? "mp4";
  const outputPath = path.join(sessionDir, `${baseName}.${format}`);

  // 准备片段
  const clips = candidates
    .filter((c) => c.segment_file_path)
    .map((c) => ({
      inputPath: c.segment_file_path!,
      startSeconds: c.start_time,
      durationSeconds: c.duration,
    }));

  // 更新状态
  db.prepare("UPDATE exports SET status = 'processing', output_path = ? WHERE id = ?").run(
    outputPath,
    exportId
  );

  try {
    // 导出视频
    await exportMultiClips({
      clips,
      outputPath,
      onProgress: (percent) => {
        db.prepare("UPDATE exports SET progress = ? WHERE id = ?").run(percent, exportId);
        eventBus.publish("export.progress", { exportId, progress: percent });
      },
    });

    // 生成字幕（如果有转写）
    const transcriptSegments: Array<{ start: number; end: number; text: string }> = [];
    for (const candidate of candidates) {
      if (candidate.segment_id) {
        const transcript = row<{ segments_json: string | null }>(
          db.prepare("SELECT segments_json FROM transcripts WHERE segment_id = ?"),
          candidate.segment_id
        );

        if (transcript?.segments_json) {
          const segments = JSON.parse(transcript.segments_json) as Array<{
            start: number;
            end: number;
            text: string;
          }>;

          // 过滤出候选时间范围内的转写
          for (const seg of segments) {
            const absStart = candidate.start_time + seg.start;
            if (absStart >= candidate.start_time && absStart < candidate.end_time) {
              transcriptSegments.push(seg);
            }
          }
        }
      }
    }

    if (transcriptSegments.length > 0) {
      const srtPath = path.join(sessionDir, `${baseName}.srt`);
      generateSrt(srtPath, transcriptSegments);
    }

    // 完成
    db.prepare(
      "UPDATE exports SET status = 'completed', progress = 100 WHERE id = ?"
    ).run(exportId);

    eventBus.publish("export.completed", { exportId, outputPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(
      "UPDATE exports SET status = 'error', error_msg = ? WHERE id = ?"
    ).run(message, exportId);

    eventBus.publish("export.failed", { exportId, error: message });
    throw error;
  }
}
