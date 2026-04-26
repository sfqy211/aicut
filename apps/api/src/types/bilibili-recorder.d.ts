declare module "@bililive-tools/bilibili-recorder/lib/stream.js" {
  export function getInfo(roomId: string): Promise<any>;
  export function getStream(options: any): Promise<any>;
  export function getLiveStatus(roomId: string): Promise<any>;
}

declare module "@bililive-tools/bilibili-recorder/lib/blive-message-listener/index.js" {
  export function startListen(roomId: number, handler: any, options?: any): any;
}
