from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from config import settings
from whisper_worker import transcribe

app = FastAPI(title="AICut ASR Worker", version="0.1.0")


class TranscribeRequest(BaseModel):
    file_path: str = Field(min_length=1)


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "model": settings.model,
        "device": settings.device,
        "compute_type": settings.compute_type,
        "allow_stub": settings.allow_stub,
    }


@app.post("/transcribe")
def transcribe_endpoint(payload: TranscribeRequest) -> dict:
    try:
        return transcribe(payload.file_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
