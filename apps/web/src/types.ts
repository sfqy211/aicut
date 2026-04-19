export type Source = {
  id: number;
  platform: string;
  room_id: string;
  streamer_name?: string;
  auto_record: number;
  created_at: number;
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
