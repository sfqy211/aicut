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
  start_time: number;
  end_time: number;
  duration: number;
  score_total: number;
  ai_summary?: string;
  ai_title_suggestion?: string;
  ai_reason?: string;
  status: "pending" | "approved" | "rejected";
};

export type ExportJob = {
  id: number;
  session_id: number;
  output_path?: string;
  status: string;
  progress: number;
  created_at: number;
};
