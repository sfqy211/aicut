import { config } from "../../config.js";

export type StandardASRSegment = {
  start: number;
  end: number;
  text: string;
};

export type StandardASRWord = {
  word: string;
  start: number;
  end: number;
};

export type StandardASRResult = {
  text: string;
  duration?: number;
  language?: string;
  segments: StandardASRSegment[];
  words?: StandardASRWord[];
};

export async function transcribeFile(filePath: string): Promise<StandardASRResult> {
  const response = await fetch(`${config.asrWorkerUrl}/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_path: filePath })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ASR worker failed: ${response.status} ${body}`);
  }

  return (await response.json()) as StandardASRResult;
}
