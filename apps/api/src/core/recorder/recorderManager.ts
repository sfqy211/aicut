// recorderManager.ts —— HLS 直录引擎的薄包装层
// 核心逻辑已迁移到 engine.ts，此文件仅保留对外接口兼容性

export {
  getRecorderStatus,
  getSourceRuntime,
  listSourceRuntime,
  startRecorder,
  stopRecorder,
  restoreAutoRecorders,
  updateRecorderFfmpegPath,
  findLatestLocalCover,
} from "./engine.js";

export type { RuntimeStatus, RecorderStatus } from "./engine.js";
