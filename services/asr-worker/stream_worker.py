import io
import subprocess
import threading
import time
from collections import deque
from typing import Callable

import numpy as np

from config import settings
from sensevoice_worker import transcribe_buffer


class VADBuffer:
    """基于 webrtcvad 的语音活动检测缓冲器。"""

    def __init__(self, sensitivity: int = 2, sample_rate: int = 16000):
        import webrtcvad
        self.vad = webrtcvad.Vad(sensitivity)
        self.sample_rate = sample_rate
        self.frame_duration_ms = 30  # webrtcvad 支持 10/20/30ms
        self.frame_size = int(sample_rate * self.frame_duration_ms / 1000)
        self.buffer = b""
        self.speech_buffer = b""
        self.is_speech = False
        self.silence_frames = 0
        self.max_silence_frames = 30  # ~900ms 静音后截断

    def feed(self, pcm_bytes: bytes) -> list[bytes]:
        self.buffer += pcm_bytes
        chunks: list[bytes] = []
        while len(self.buffer) >= self.frame_size * 2:  # s16 = 2 bytes/sample
            frame = self.buffer[: self.frame_size * 2]
            self.buffer = self.buffer[self.frame_size * 2 :]
            is_speech = self.vad.is_speech(frame, self.sample_rate)

            if is_speech:
                self.silence_frames = 0
                if not self.is_speech:
                    self.is_speech = True
                self.speech_buffer += frame
            else:
                self.silence_frames += 1
                if self.is_speech:
                    if self.silence_frames < self.max_silence_frames:
                        self.speech_buffer += frame
                    else:
                        # 语音结束
                        chunks.append(self.speech_buffer)
                        self.speech_buffer = b""
                        self.is_speech = False
        return chunks

    def flush(self) -> bytes | None:
        if self.speech_buffer:
            buf = self.speech_buffer
            self.speech_buffer = b""
            self.is_speech = False
            return buf
        return None


class StreamWorker:
    def __init__(
        self,
        stream_id: str,
        stream_url: str,
        session_start_time_ms: int,
        on_result: Callable[[dict], None],
    ):
        self.stream_id = stream_id
        self.stream_url = stream_url
        self.session_start_time_ms = session_start_time_ms
        self.on_result = on_result
        self.drift_ms = 0.0
        self._running = False
        self._thread: threading.Thread | None = None
        self._segments: list[dict] = []
        self._lock = threading.Lock()

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> list[dict]:
        self._running = False
        if self._thread:
            self._thread.join(timeout=10)
        with self._lock:
            return list(self._segments)

    def _run(self):
        # 计算漂移：ASR 启动时间 - session 开始时间
        asr_start_time = time.time() * 1000
        self.drift_ms = asr_start_time - self.session_start_time_ms
        print(f"[ASR Stream {self.stream_id}] driftMs={self.drift_ms:.0f}")

        # FFmpeg 拉取音频流 -> 16kHz mono s16 PCM
        cmd = [
            "ffmpeg",
            "-y",
            "-i", self.stream_url,
            "-vn",
            "-acodec", "pcm_s16le",
            "-ac", "1",
            "-ar", str(settings.sample_rate),
            "-f", "s16le",
            "-",
        ]

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=10 * 1024 * 1024,
        )

        vad = VADBuffer(sensitivity=settings.vad_sensitivity, sample_rate=settings.sample_rate)
        chunk_duration_ms = settings.chunk_duration_ms
        chunk_bytes = int(settings.sample_rate * chunk_duration_ms / 1000) * 2  # s16

        try:
            while self._running:
                raw = process.stdout.read(chunk_bytes)
                if not raw:
                    time.sleep(0.1)
                    continue

                # VAD 检测（处理多个语音片段）
                for speech in vad.feed(raw):
                    # 转换为 float32 numpy 数组
                    audio = np.frombuffer(speech, dtype=np.int16).astype(np.float32) / 32768.0

                    # SenseVoice 识别
                    result = transcribe_buffer(audio, sample_rate=settings.sample_rate)
                    if not result["text"]:
                        continue

                    # 计算全局时间戳
                    now_ms = time.time() * 1000
                    buffer_duration_ms = (len(audio) / settings.sample_rate) * 1000
                    raw_start = (now_ms - self.session_start_time_ms) / 1000.0 - (buffer_duration_ms / 1000.0)
                    calibrated_start = raw_start - (self.drift_ms / 1000.0)
                    calibrated_end = (now_ms - self.session_start_time_ms) / 1000.0 - (self.drift_ms / 1000.0)

                    segment = {
                        "start": max(0.0, calibrated_start),
                        "end": max(0.0, calibrated_end),
                        "text": result["text"],
                        "isPartial": True,
                    }

                    with self._lock:
                        self._segments.append(segment)

                    self.on_result({
                        "type": "partial",
                        "stream_id": self.stream_id,
                        "segment": segment,
                    })
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()

            # 发送最终结果
            final_flush = vad.flush()
            if final_flush:
                audio = np.frombuffer(final_flush, dtype=np.int16).astype(np.float32) / 32768.0
                result = transcribe_buffer(audio, sample_rate=settings.sample_rate)
                if result["text"]:
                    now_ms = time.time() * 1000
                    calibrated_end = (now_ms - self.session_start_time_ms) / 1000.0 - (self.drift_ms / 1000.0)
                    segment = {
                        "start": max(0.0, calibrated_end - len(audio) / settings.sample_rate),
                        "end": max(0.0, calibrated_end),
                        "text": result["text"],
                        "isPartial": False,
                    }
                    with self._lock:
                        self._segments.append(segment)
                    self.on_result({
                        "type": "final",
                        "stream_id": self.stream_id,
                        "segment": segment,
                    })
