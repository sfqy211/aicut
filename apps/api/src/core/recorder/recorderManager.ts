export type RecorderStatus = {
  enabled: boolean;
  message: string;
};

export function getRecorderStatus(): RecorderStatus {
  return {
    enabled: false,
    message:
      "Recorder integration is scaffolded. Next step: wire @bililive-tools/manager and @bililive-tools/bilibili-recorder."
  };
}
