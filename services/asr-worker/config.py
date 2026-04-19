import os


class Settings:
    host: str = os.getenv("AICUT_ASR_HOST", "127.0.0.1")
    port: int = int(os.getenv("AICUT_ASR_PORT", "43112"))
    model: str = os.getenv("AICUT_ASR_MODEL", "small")
    device: str = os.getenv("AICUT_ASR_DEVICE", "auto")
    compute_type: str = os.getenv("AICUT_ASR_COMPUTE_TYPE", "int8")
    language: str = os.getenv("AICUT_ASR_LANGUAGE", "zh")
    allow_stub: bool = os.getenv("AICUT_ASR_ALLOW_STUB", "0") == "1"


settings = Settings()
