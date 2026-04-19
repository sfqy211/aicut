export type CandidateScoreInput = {
  danmakuCount: number;
  paidInteractionCents: number;
  transcriptText: string;
  durationSeconds: number;
};

export type CandidateScore = {
  total: number;
  danmaku: number;
  interaction: number;
  transcript: number;
  energy: number;
};

const highEnergyWords = ["爆", "笑死", "名场面", "高能", "离谱", "绷不住", "逆天", "经典"];

export function scoreCandidate(input: CandidateScoreInput): CandidateScore {
  const duration = Math.max(input.durationSeconds, 1);
  const danmakuPerMinute = (input.danmakuCount / duration) * 60;
  const danmaku = Math.min(100, danmakuPerMinute * 8);
  const interaction = Math.min(100, input.paidInteractionCents / 100);
  const transcriptHits = highEnergyWords.filter((word) => input.transcriptText.includes(word)).length;
  const transcript = Math.min(100, transcriptHits * 25);
  const energy = Math.min(100, Math.max(danmaku, transcript) * 0.65);
  const total = danmaku * 0.35 + interaction * 0.2 + transcript * 0.3 + energy * 0.15;

  return {
    total: Number(total.toFixed(2)),
    danmaku: Number(danmaku.toFixed(2)),
    interaction: Number(interaction.toFixed(2)),
    transcript: Number(transcript.toFixed(2)),
    energy: Number(energy.toFixed(2))
  };
}
