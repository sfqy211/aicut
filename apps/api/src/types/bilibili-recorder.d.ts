declare module "@bililive-tools/bilibili-recorder/stream.js" {
  export function getStream(opts: {
    channelId: string;
    quality: number;
    cookie?: string;
    onlyAudio?: boolean;
    formatName?: string;
    codecName?: string;
    strictQuality?: boolean;
    customHost?: string;
  }): Promise<{
    currentStream: {
      name: string;
      source: string;
      url: string;
    };
    [key: string]: unknown;
  }>;
}
