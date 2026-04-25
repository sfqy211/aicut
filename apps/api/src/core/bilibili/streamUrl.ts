import { getStream } from "@bililive-tools/bilibili-recorder/stream.js";

export async function getAudioStreamUrl(roomId: string, cookie?: string): Promise<string> {
  const result = await getStream({
    channelId: roomId,
    quality: 10000,
    cookie,
    onlyAudio: true,
    formatName: "auto",
    codecName: "auto",
  });
  return result.currentStream.url;
}
