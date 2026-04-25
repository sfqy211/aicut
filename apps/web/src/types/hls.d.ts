declare module "hls.js" {
  class Hls {
    static isSupported(): boolean;
    static readonly Events: {
      MANIFEST_PARSED: string;
      [key: string]: string;
    };
    constructor(config?: Record<string, unknown>);
    loadSource(url: string): void;
    attachMedia(video: HTMLVideoElement): void;
    on(event: string, callback: (...args: any[]) => void): void;
    off(event: string, callback: (...args: any[]) => void): void;
    destroy(): void;
  }
  export default Hls;
}
