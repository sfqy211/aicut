import threading
from typing import Callable

from stream_worker import StreamWorker


class StreamManager:
    def __init__(self):
        self._workers: dict[str, StreamWorker] = {}
        self._listeners: dict[str, list[Callable]] = {}
        self._lock = threading.Lock()

    def start_stream(
        self,
        stream_id: str,
        stream_url: str,
        session_start_time_ms: int,
    ) -> None:
        with self._lock:
            if stream_id in self._workers:
                raise ValueError(f"Stream {stream_id} already running")

        def on_result(data: dict):
            with self._lock:
                listeners = self._listeners.get(stream_id, [])
            for listener in listeners:
                try:
                    listener(data)
                except Exception:
                    pass

        worker = StreamWorker(stream_id, stream_url, session_start_time_ms, on_result)
        with self._lock:
            self._workers[stream_id] = worker
        worker.start()

    def stop_stream(self, stream_id: str) -> list[dict]:
        with self._lock:
            worker = self._workers.pop(stream_id, None)
            self._listeners.pop(stream_id, None)
        if not worker:
            raise ValueError(f"Stream {stream_id} not found")
        return worker.stop()

    def add_listener(self, stream_id: str, listener: Callable) -> None:
        with self._lock:
            self._listeners.setdefault(stream_id, []).append(listener)

    def remove_listener(self, stream_id: str, listener: Callable) -> None:
        with self._lock:
            if stream_id in self._listeners:
                self._listeners[stream_id] = [l for l in self._listeners[stream_id] if l is not listener]


stream_manager = StreamManager()
