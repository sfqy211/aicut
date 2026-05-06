export type Source = {
  id: number;
  platform: string;
  room_id: string;
  streamer_name?: string;
  cookie?: string | null;
  auto_record: number;
  analysis_interval: number;
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
    liveInfo?: {
      living?: boolean;
      owner?: string;
      title?: string;
      avatar?: string;
      cover?: string;
    };
    localCoverPath?: string | null;
    lastRecordTime?: number | null;
    lastSessionTitle?: string | null;
  } | null;
};

export type Session = {
  id: number;
  title?: string;
  session_type: "live" | "import";
  status: string;
  streamer_name?: string;
  room_id?: string;
  live_id?: string;
  cover_url?: string;
  start_time?: number;
  end_time?: number;
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
  start_time: number;
  end_time: number;
  duration: number;
  ai_description: string | null;
  status: "pending" | "approved" | "rejected";
  user_note?: string | null;
  created_at: number;
  updated_at?: number;
};

export type CandidateDetail = Candidate & {
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

export interface ExportRange {
  start: number;
  end: number;
}

export interface ClipSelection {
  start: number;
  end: number;
  candidateId?: number | null;
}

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

export type DanmakuEvent = {
  id: number;
  event_type: "danmaku" | "super_chat" | "gift" | "guard";
  timestamp_ms: number;
  text: string;
  user_id: string | null;
  price: number;
};

export type SettingsMap = Record<string, { value: string | null; updatedAt: number }>;
