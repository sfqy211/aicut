import re
from functools import lru_cache
from typing import Any

import librosa
import numpy as np

from config import settings


@lru_cache(maxsize=1)
def get_model() -> Any:
    try:
        from funasr import AutoModel
    except ImportError as exc:
        raise RuntimeError("funasr is not installed") from exc

    device = "cpu" if settings.device == "auto" else settings.device
    model = AutoModel(
        model=settings.model,
        device=device,
        load_in_8bit=settings.load_in_8bit,
    )
    return model


_LANG_PATTERN = re.compile(r"<\|([a-z]{2}|yue|auto)\|>")


def _strip_lang_tags(text: str) -> str:
    return _LANG_PATTERN.sub("", text).strip()


def transcribe_file(file_path: str) -> dict:
    model = get_model()
    result = model.generate(
        input=file_path,
        language=settings.language if settings.language != "auto" else None,
    )

    # FunASR 返回格式: [{"key": "wav_file", "text": "<|zh|>...", "timestamp": [...]}]
    if not result:
        return {
            "text": "",
            "language": settings.language,
            "segments": [],
            "words": [],
        }

    item = result[0]
    raw_text = item.get("text", "")
    text = _strip_lang_tags(raw_text)

    segments = []
    words = []
    timestamps = item.get("timestamp", [])

    if timestamps:
        # timestamp 格式: [[start_ms, end_ms], [start_ms, end_ms], ...] 对应每个 token/字
        # 合并为 segment 级别
        seg_start = None
        seg_text = ""
        for idx, ts in enumerate(timestamps):
            if not ts or len(ts) < 2:
                continue
            start_ms, end_ms = ts[0], ts[1]
            if seg_start is None:
                seg_start = start_ms / 1000.0
            # 取对应字（近似）
            if idx < len(text):
                seg_text += text[idx]
            # 简单分段：当停顿 > 500ms 或长度足够时结束
            if idx + 1 < len(timestamps):
                next_start = timestamps[idx + 1][0]
                if next_start - end_ms > 500:
                    segments.append({
                        "start": seg_start,
                        "end": end_ms / 1000.0,
                        "text": seg_text.strip(),
                    })
                    seg_start = None
                    seg_text = ""
        if seg_start is not None and seg_text:
            segments.append({
                "start": seg_start,
                "end": timestamps[-1][1] / 1000.0 if timestamps else seg_start + 1,
                "text": seg_text.strip(),
            })

    return {
        "text": text,
        "language": settings.language,
        "segments": segments,
        "words": words,
    }


def transcribe_buffer(audio_buffer: np.ndarray, sample_rate: int = 16000) -> dict:
    """对内存中的音频数据进行识别，返回标准格式。"""
    model = get_model()
    result = model.generate(
        input=audio_buffer,
        input_fs=sample_rate,
        language=settings.language if settings.language != "auto" else None,
    )

    if not result:
        return {"text": "", "language": settings.language, "segments": [], "words": []}

    item = result[0]
    raw_text = item.get("text", "")
    text = _strip_lang_tags(raw_text)

    segments = []
    timestamps = item.get("timestamp", [])
    if timestamps:
        seg_start = None
        seg_text = ""
        for idx, ts in enumerate(timestamps):
            if not ts or len(ts) < 2:
                continue
            start_ms, end_ms = ts[0], ts[1]
            if seg_start is None:
                seg_start = start_ms / 1000.0
            if idx < len(text):
                seg_text += text[idx]
            if idx + 1 < len(timestamps):
                next_start = timestamps[idx + 1][0]
                if next_start - end_ms > 500:
                    segments.append({
                        "start": seg_start,
                        "end": end_ms / 1000.0,
                        "text": seg_text.strip(),
                    })
                    seg_start = None
                    seg_text = ""
        if seg_start is not None and seg_text:
            segments.append({
                "start": seg_start,
                "end": timestamps[-1][1] / 1000.0 if timestamps else seg_start + 1,
                "text": seg_text.strip(),
            })

    return {
        "text": text,
        "language": settings.language,
        "segments": segments,
        "words": [],
    }
