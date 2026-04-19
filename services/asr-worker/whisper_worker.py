from functools import lru_cache
from typing import Any

from config import settings


@lru_cache(maxsize=1)
def get_model() -> Any:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError("faster-whisper is not installed") from exc

    device = "cpu" if settings.device == "auto" else settings.device
    return WhisperModel(settings.model, device=device, compute_type=settings.compute_type)


def transcribe(file_path: str) -> dict:
    if settings.allow_stub:
        return {
            "text": "",
            "language": settings.language,
            "segments": [],
            "words": [],
        }

    model = get_model()
    segments_iter, info = model.transcribe(
        file_path,
        language=settings.language,
        vad_filter=True,
        word_timestamps=True,
    )

    segments = []
    words = []
    full_text_parts = []

    for segment in segments_iter:
        text = segment.text.strip()
        segments.append({"start": segment.start, "end": segment.end, "text": text})
        full_text_parts.append(text)
        for word in segment.words or []:
            words.append({"word": word.word, "start": word.start, "end": word.end})

    return {
        "text": "".join(full_text_parts),
        "duration": getattr(info, "duration", None),
        "language": getattr(info, "language", settings.language),
        "segments": segments,
        "words": words,
    }
