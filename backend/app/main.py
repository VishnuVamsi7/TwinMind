from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

TRANSCRIPTION_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions"
CHAT_COMPLETIONS_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_SUGGESTION_MODEL = "openai/gpt-oss-120b"

app = FastAPI(title="TwinMind Assessment API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


async def stream_groq_transcription(
    audio_bytes: bytes,
    filename: str,
    content_type: str,
    model: str,
    api_key: str,
):
    file_extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else "unknown"
    print(f"[transcribe] Sending chunk to Groq filename={filename} extension={file_extension} size_bytes={len(audio_bytes)}")

    files = {"file": (filename, audio_bytes, content_type)}
    data = {"model": model}
    headers = {"Authorization": f"Bearer {api_key}"}

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            response = await client.post(
                TRANSCRIPTION_ENDPOINT,
                headers=headers,
                data=data,
                files=files,
            )
        except httpx.HTTPError as exc:
            message = f"Groq request failed: {exc}"
            yield json.dumps({"text": message, "done": True, "error": True}).encode("utf-8") + b"\n"
            return

    if response.status_code >= 400:
        detail = response.text or "Groq returned an error."
        yield json.dumps({"text": detail, "done": True, "error": True}).encode("utf-8") + b"\n"
        return

    try:
        payload = response.json()
    except json.JSONDecodeError:
        payload = {"text": response.text}

    if isinstance(payload, dict) and payload.get("error"):
        error_details = payload.get("error")
        print(f"[transcribe] Groq returned error payload: {error_details}")
        yield json.dumps({"text": "[Unrecognized Audio]", "done": True, "error": True}).encode("utf-8") + b"\n"
        return

    collected_text = str(payload.get("text", "")).strip()
    if not collected_text:
        yield json.dumps({"text": "", "done": True}).encode("utf-8") + b"\n"
        return

    words = collected_text.split()
    for index, word in enumerate(words):
        suffix = " " if index < len(words) - 1 else ""
        yield json.dumps({"delta": f"{word}{suffix}", "done": False}).encode("utf-8") + b"\n"
        await asyncio.sleep(0.01)

    yield json.dumps({"text": collected_text, "done": True}).encode("utf-8") + b"\n"


@app.post("/transcribe")
async def transcribe_audio_stream(
    file: UploadFile = File(...),
    model: str = Form("whisper-large-v3"),
    apiKey: str = Form(...),
    chunkId: int = Form(...),
) -> StreamingResponse:
    if not apiKey.strip():
        raise HTTPException(status_code=400, detail="Missing GROQ_API_KEY.")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio file is empty.")

    stream = stream_groq_transcription(
        audio_bytes=audio_bytes,
        filename=file.filename or f"segment-{chunkId}.webm",
        content_type=file.content_type or "audio/webm",
        model=model,
        api_key=apiKey.strip(),
    )

    return StreamingResponse(stream, media_type="application/x-ndjson")


class SuggestionsRequest(BaseModel):
    """Primary input is always a single segment; optional extended context is supplementary."""

    chunk_text: str = Field(..., min_length=1)
    chunk_id: int
    api_key: str = Field(..., min_length=1)
    model: str = Field(default=DEFAULT_SUGGESTION_MODEL)
    use_extended_context: bool = False
    extended_context_transcript: Optional[str] = None
    context_minutes: int = Field(default=8, ge=1, le=120)
    system_prompt_chunk_only: Optional[str] = Field(default=None, max_length=24_000)
    system_prompt_extended: Optional[str] = Field(default=None, max_length=24_000)


SUGGESTIONS_CHUNK_ONLY = """You are TwinMind — live suggestions for a real-time conversation.

## Input (strict)
You receive **one segment only** (the latest ~30s of speech, tagged with chunk_id). Base **all three** suggestions **only** on this segment text. Do not assume facts not present in the segment.

## Task
Produce **exactly 3** high-signal, actionable items the speaker could use immediately.

## Types — use a **mix** (do not use the same `kind` for all three)
- `question`: Follow-up that deepens or clarifies what was just said.
- `talking_point`: Angle, contrast, or point worth raising next.
- `answer`: Only if a question was clearly asked **in this segment**; else use another type.
- `fact_check`: A claim or number in this segment worth verifying.
- `clarify`: Define or disambiguate a term used in this segment.

## Rules
- Short, scannable `preview` (~140 chars max). Richer `detail` (2–4 sentences).
- No filler. No invented facts.

## Output (strict JSON only, no markdown)
{"suggestions":[{"kind":"question|talking_point|answer|fact_check|clarify","preview":"string","detail":"string"},...]}
Exactly 3 objects."""


SUGGESTIONS_WITH_EXTENDED = """You are TwinMind — live suggestions for a real-time conversation.

## Input
1) **PRIMARY**: One segment (latest ~30s) — this is the main basis for all three suggestions.
2) **OPTIONAL REFERENCE**: Additional transcript from a longer rolling window. Use it only to disambiguate names, threads, or jargon **mentioned in the primary segment**. Do **not** introduce topics that appear only in the reference and not in the primary segment.

## Task
Produce **exactly 3** suggestions grounded primarily in the **primary** segment.

## Types — mix across the three (no duplicate kinds for all three)
- `question`, `talking_point`, `answer`, `fact_check`, `clarify` (same meanings as TwinMind spec).

## Output (strict JSON only)
{"suggestions":[{"kind":"question|talking_point|answer|fact_check|clarify","preview":"string","detail":"string"},...]}
Exactly 3 objects."""


@app.post("/api/suggestions")
async def create_suggestions(body: SuggestionsRequest) -> dict[str, Any]:
    api_key = body.api_key.strip()
    chunk_text = body.chunk_text.strip()
    extended_text = (body.extended_context_transcript or "").strip()

    if body.use_extended_context and extended_text:
        custom_ext = (body.system_prompt_extended or "").strip()
        system = custom_ext if custom_ext else SUGGESTIONS_WITH_EXTENDED
        user_content = (
            f"chunk_id={body.chunk_id}\n\n"
            f"PRIMARY SEGMENT (base suggestions on this):\n{chunk_text}\n\n"
            f"OPTIONAL REFERENCE (rolling ~{body.context_minutes} min window, chunk-tagged):\n"
            f"{extended_text}"
        )
    else:
        custom_chunk = (body.system_prompt_chunk_only or "").strip()
        system = custom_chunk if custom_chunk else SUGGESTIONS_CHUNK_ONLY
        user_content = f"chunk_id={body.chunk_id}\n\nSEGMENT TEXT:\n{chunk_text}"

    payload: dict[str, Any] = {
        "model": body.model,
        "temperature": 0.65,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
        "response_format": {"type": "json_object"},
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            response = await client.post(CHAT_COMPLETIONS_ENDPOINT, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Groq request failed: {exc}") from exc

        if response.status_code >= 400 and "response_format" in payload:
            payload.pop("response_format", None)
            print("[suggestions] Retrying without response_format (model may not support json_object).")
            response = await client.post(CHAT_COMPLETIONS_ENDPOINT, headers=headers, json=payload)

    if response.status_code >= 400:
        print(f"[suggestions] Groq HTTP {response.status_code}: {response.text[:500]}")
        raise HTTPException(status_code=response.status_code, detail=response.text or "Groq error")

    try:
        outer = response.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Invalid JSON from Groq")

    if isinstance(outer, dict) and outer.get("error"):
        print(f"[suggestions] Groq error key: {outer.get('error')}")
        raise HTTPException(status_code=400, detail=str(outer.get("error")))

    choices = outer.get("choices") or []
    if not choices:
        raise HTTPException(status_code=502, detail="No choices in Groq response")

    content = (choices[0].get("message") or {}).get("content") or ""
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        print(f"[suggestions] Failed to parse model JSON: {content[:400]}")
        raise HTTPException(status_code=502, detail="Model did not return valid JSON")

    raw_list = parsed.get("suggestions") if isinstance(parsed, dict) else None
    if not isinstance(raw_list, list):
        raise HTTPException(status_code=502, detail="Missing suggestions array")

    items: list[dict[str, str]] = []
    for row in raw_list[:3]:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind", "talking_point"))
        preview = str(row.get("preview", "")).strip()
        detail = str(row.get("detail", "")).strip()
        if not preview:
            continue
        items.append(
            {
                "id": str(uuid.uuid4()),
                "kind": kind,
                "preview": preview[:280],
                "detail": detail or preview,
            }
        )

    while len(items) < 3:
        items.append(
            {
                "id": str(uuid.uuid4()),
                "kind": "clarify",
                "preview": "Continue the discussion — more transcript needed for richer suggestions.",
                "detail": "The model returned fewer than 3 items; pad with this placeholder.",
            }
        )

    batch_id = str(uuid.uuid4())
    return {
        "batch": {
            "id": batch_id,
            "createdAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "model": body.model,
            "triggerChunkId": body.chunk_id,
            "items": items[:3],
        }
    }


class ChatExpandRequest(BaseModel):
    api_key: str = Field(..., min_length=1)
    model: str = Field(default=DEFAULT_SUGGESTION_MODEL)
    suggestion_kind: str = ""
    suggestion_preview: str = Field(..., min_length=1)
    suggestion_detail: str = ""
    transcript_context: str = ""
    system_prompt: Optional[str] = Field(default=None, max_length=24_000)


CHAT_EXPAND_SYSTEM = """You are TwinMind Chat. The user tapped a live suggestion card.
Give a clear, well-structured detailed answer they can use in the conversation.
Be concise but substantive. If fact-checking, say what to verify and how. If a question, frame follow-ups."""


@app.post("/api/chat-expand")
async def expand_suggestion(body: ChatExpandRequest) -> dict[str, str]:
    api_key = body.api_key.strip()
    user_parts = [
        f"Suggestion type: {body.suggestion_kind or 'general'}",
        f"Card preview: {body.suggestion_preview}",
    ]
    if body.suggestion_detail:
        user_parts.append(f"Card detail: {body.suggestion_detail}")
    if body.transcript_context.strip():
        user_parts.append(f"Recent transcript for grounding:\n{body.transcript_context.strip()}")
    user_content = "\n\n".join(user_parts)

    custom_sys = (body.system_prompt or "").strip()
    system_content = custom_sys if custom_sys else CHAT_EXPAND_SYSTEM

    payload = {
        "model": body.model,
        "temperature": 0.5,
        "messages": [
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
        ],
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            response = await client.post(CHAT_COMPLETIONS_ENDPOINT, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Groq request failed: {exc}") from exc

    if response.status_code >= 400:
        print(f"[chat-expand] Groq HTTP {response.status_code}: {response.text[:500]}")
        raise HTTPException(status_code=response.status_code, detail=response.text or "Groq error")

    try:
        outer = response.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Invalid JSON from Groq")

    if isinstance(outer, dict) and outer.get("error"):
        print(f"[chat-expand] Groq error key: {outer.get('error')}")
        raise HTTPException(status_code=400, detail=str(outer.get("error")))

    choices = outer.get("choices") or []
    if not choices:
        raise HTTPException(status_code=502, detail="No choices in Groq response")

    text = ((choices[0].get("message") or {}).get("content") or "").strip()
    return {"answer": text or "(No response text.)"}


class ChatContinueRequest(BaseModel):
    api_key: str = Field(..., min_length=1)
    model: str = Field(default=DEFAULT_SUGGESTION_MODEL)
    transcript_context: str = ""
    conversation: list[dict[str, str]] = Field(default_factory=list)
    user_message: str = Field(..., min_length=1)
    system_prompt: Optional[str] = Field(default=None, max_length=24_000)


CHAT_CONTINUE_SYSTEM = """You are TwinMind Copilot Chat.
Continue the user's thought in a conversational way while staying grounded in the meeting context.

Formatting:
- Use markdown when it improves readability.
- Support headings like ### and emphasis like **bold** naturally.
- Keep answers concise, practical, and easy to scan.
"""


@app.post("/api/chat-continue")
async def continue_chat(body: ChatContinueRequest) -> dict[str, str]:
    api_key = body.api_key.strip()
    custom_sys = (body.system_prompt or "").strip()
    primary_system = custom_sys if custom_sys else CHAT_CONTINUE_SYSTEM
    messages: list[dict[str, str]] = [{"role": "system", "content": primary_system}]

    if body.transcript_context.strip():
        messages.append(
            {
                "role": "system",
                "content": f"Recent transcript context:\n{body.transcript_context.strip()}",
            }
        )

    # Keep only recent turns for latency and relevance.
    for item in body.conversation[-12:]:
        role = item.get("role", "")
        content = item.get("content", "")
        if role in {"user", "assistant"} and content:
            messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": body.user_message.strip()})

    payload = {
        "model": body.model,
        "temperature": 0.55,
        "messages": messages,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            response = await client.post(CHAT_COMPLETIONS_ENDPOINT, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Groq request failed: {exc}") from exc

    if response.status_code >= 400:
        print(f"[chat-continue] Groq HTTP {response.status_code}: {response.text[:500]}")
        raise HTTPException(status_code=response.status_code, detail=response.text or "Groq error")

    try:
        outer = response.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Invalid JSON from Groq")

    if isinstance(outer, dict) and outer.get("error"):
        print(f"[chat-continue] Groq error key: {outer.get('error')}")
        raise HTTPException(status_code=400, detail=str(outer.get("error")))

    choices = outer.get("choices") or []
    if not choices:
        raise HTTPException(status_code=502, detail="No choices in Groq response")

    text = ((choices[0].get("message") or {}).get("content") or "").strip()
    return {"answer": text or "(No response text.)"}


@app.get("/api/placeholders")
async def model_placeholders() -> dict[str, str]:
    return {
        "transcription_model": "whisper-large-v3",
        "suggestion_model": DEFAULT_SUGGESTION_MODEL,
        "chat_model": DEFAULT_SUGGESTION_MODEL,
    }
