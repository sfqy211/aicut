import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from starlette.responses import StreamingResponse

from config import settings
from sensevoice_worker import transcribe_file
from stream_manager import stream_manager

app = FastAPI(title="AICut ASR Worker", version="2.0.0")


class TranscribeRequest(BaseModel):
    file_path: str = Field(min_length=1)


class StreamStartRequest(BaseModel):
    stream_id: str = Field(min_length=1)
    stream_url: str = Field(min_length=1)
    session_start_time_ms: int = Field(gt=0)


class StreamStopRequest(BaseModel):
    stream_id: str = Field(min_length=1)


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "model": settings.model,
        "device": settings.device,
        "load_in_8bit": settings.load_in_8bit,
        "language": settings.language,
    }


@app.post("/transcribe")
def transcribe_endpoint(payload: TranscribeRequest) -> dict:
    try:
        return transcribe_file(payload.file_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/stream/start")
def stream_start(payload: StreamStartRequest) -> dict:
    try:
        stream_manager.start_stream(
            payload.stream_id,
            payload.stream_url,
            payload.session_start_time_ms,
        )
        return {"ok": True, "stream_id": payload.stream_id}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/stream/stop")
def stream_stop(payload: StreamStopRequest) -> dict:
    try:
        segments = stream_manager.stop_stream(payload.stream_id)
        return {"ok": True, "stream_id": payload.stream_id, "segments": segments}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/stream/{stream_id}/events")
async def stream_events(stream_id: str):
    async def event_generator():
        queue: asyncio.Queue[dict] = asyncio.Queue()

        def on_event(data: dict):
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                pass

        stream_manager.add_listener(stream_id, on_event)
        try:
            while True:
                data = await asyncio.wait_for(queue.get(), timeout=30)
                yield f"event: asr_result\ndata: {json.dumps(data)}\n\n"
        except asyncio.TimeoutError:
            yield f"event: heartbeat\ndata: {{}}\n\n"
        finally:
            stream_manager.remove_listener(stream_id, on_event)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=settings.host, port=settings.port)
