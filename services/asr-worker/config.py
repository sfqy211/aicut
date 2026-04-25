import os


class Settings:
    host: str = os.getenv("AICUT_ASR_HOST", "127.0.0.1")
    port: int = int(os.getenv("AICUT_ASR_PORT", "43112"))
    model: str = os.getenv("AICUT_ASR_MODEL", "iic/SenseVoiceSmall")
    device: str = os.getenv("AICUT_ASR_DEVICE", "auto")
    language: str = os.getenv("AICUT_ASR_LANGUAGE", "auto")
    load_in_8bit: bool = os.getenv("AICUT_ASR_LOAD_IN_8BIT", "1") == "1"
    vad_sensitivity: int = int(os.getenv("AICUT_ASR_VAD_SENSITIVITY", "2"))
    chunk_duration_ms: int = int(os.getenv("AICUT_ASR_CHUNK_DURATION_MS", "60"))
    sample_rate: int = int(os.getenv("AICUT_ASR_SAMPLE_RATE", "16000"))


settings = Settings()
