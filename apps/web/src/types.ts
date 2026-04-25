export type Source = {
  id: number;
  platform: string;
  room_id: string;
  streamer_name?: string;
  cookie?: string | null;
  auto_record: number;
  created_at: number;
  runtime?: {
    sourceId: number;
    recorderId: string;
    monitoring: boolean;
    state: "idle" | "monitoring" | "recording" | "stopping" | "error";
    sessionId: number | null;
    progressTime: string | null;
    lastError: string | null;
    updatedAt: number;
  } | null;
};

export type Session = {
  id: number;
  title?: string;
  session_type: "live" | "import";
  status: string;
  streamer_name?: string;
  room_id?: string;
  total_duration?: number;
  total_size?: number;
  created_at: number;
};

export type SessionOverview = {
  recording: number;
  transcribing: number;
  queued: number;
  readySegments: number;
  pendingCandidates: number;
};

export type SessionSegment = {
  id: number;
  session_id: number;
  file_path: string;
  start_offset: number;
  duration?: number | null;
  size?: number | null;
  has_danmaku: number;
  danmaku_path?: string | null;
  status: string;
  error_msg?: string | null;
  transcript_text?: string | null;
  segments_json?: string | null;
  danmaku_count: number;
};

export type SessionDetail = {
  session: Session;
  segments: SessionSegment[];
  candidates: Candidate[];
};

export type Candidate = {
  id: number;
  session_id: number;
  segment_id?: number | null;
  start_time: number;
  end_time: number;
  duration: number;
  // 规则评分
  rule_score: number;
  score_danmaku: number;
  score_interaction: number;
  score_transcript: number;
  score_energy: number;
  // 最终评分
  score_total: number;
  // LLM 结果
  llm_score?: number | null;
  llm_category?: string | null;
  llm_confidence?: number | null;
  llm_worth?: number | null;
  llm_risk?: string | null;
  // AI 推荐
  ai_summary?: string | null;
  ai_title_suggestion?: string | null;
  ai_reason?: string | null;
  ai_highlight?: string | null;
  // 时间调整建议
  suggested_trim_start: number;
  suggested_trim_end: number;
  // 审核状态
  status: "pending" | "approved" | "rejected";
  user_note?: string | null;
  // 关联信息
  session_title?: string;
  session_duration?: number;
  created_at: number;
  updated_at?: number;
};

export type CandidateDetail = Candidate & {
  segment_file_path?: string | null;
  segment_start_offset?: number | null;
  segment_duration?: number | null;
  preview_start_time?: number;
  preview_end_time?: number;
  preview_duration?: number;
  preview_padding?: number;
  relative_clip_start?: number;
  relative_clip_end?: number;
  preview_url?: string;
};

export type ExportJob = {
  id: number;
  session_id: number;
  candidate_ids: string;
  output_path?: string;
  status: string;
  progress: number;
  error_msg?: string | null;
  created_at: number;
};

export type ExportOptions = {
  hardcodeSubtitles?: boolean;
  hardcodeDanmaku?: boolean;
  quality?: "original" | "1080p" | "720p";
  format?: "mp4" | "webm";
};

export type LiveTranscriptChunk = {
  start: number;
  end: number;
  text: string;
  isPartial?: boolean;
};

export type SessionTranscript = {
  sessionId: number;
  segments: LiveTranscriptChunk[];
  status: "recording" | "completed" | "error";
};

export type SettingsMap = Record<string, { value: string | null; updatedAt: number }>;

export type SystemSettings = {
  sources: number;
  sessions: number;
  segments: number;
  candidates: number;
  exports: number;
  pendingCandidates: number;
  approvedCandidates: number;
  ffmpegPath: string;
  recorderSegment: string;
  libraryRoot: string;
  disk: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usagePercent: number;
  };
};
