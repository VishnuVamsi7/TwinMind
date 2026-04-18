"use client";

import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SettingsModal, type TwinMindSettingsPayload } from "@/components/SettingsModal";
import type { ChatMessage, SuggestionBatch, SuggestionItem, SuggestionKind, TranscriptChunk } from "@/types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
const TRANSCRIPTION_MODEL = "whisper-large-v3";
const GPT_SUGGESTION_MODEL = "openai/gpt-oss-120b";
const MIN_CHUNK_BYTES = 2 * 1024;
const RECORDER_MIME_TYPE = "audio/webm;codecs=opus";
const SEGMENT_MS = 30_000;
const DEFAULT_CONTEXT_MINUTES = 8;
const DEFAULT_CHAT_CONTEXT_MINUTES = 120;
const SETTINGS_STORAGE_KEY = "twinmind-settings-v1";
const MIN_CHARS_CHUNK_SUGGEST = 8;

const KIND_TAG: Record<SuggestionKind, string> = {
  question: "QUESTION TO ASK",
  talking_point: "TALKING POINT",
  answer: "ANSWER",
  fact_check: "FACT-CHECK",
  clarify: "CLARIFY",
};

const KIND_TAG_CLASS: Record<SuggestionKind, string> = {
  question: "bg-sky-600/30 text-sky-200 border-sky-500/50",
  talking_point: "bg-violet-600/30 text-violet-200 border-violet-500/50",
  answer: "bg-emerald-600/30 text-emerald-200 border-emerald-500/50",
  fact_check: "bg-amber-600/30 text-amber-200 border-amber-500/50",
  clarify: "bg-zinc-600/40 text-zinc-200 border-zinc-500/50",
};

function normalizeKind(raw: string): SuggestionKind {
  const k = raw.toLowerCase().replace(/-/g, "_");
  if (k === "question") return "question";
  if (k === "talking_point" || k === "talkingpoint") return "talking_point";
  if (k === "answer") return "answer";
  if (k === "fact_check" || k === "factcheck") return "fact_check";
  if (k === "clarify") return "clarify";
  return "talking_point";
}

function ClientLocalTime({ iso }: { iso: string }) {
  const label = Number.isNaN(new Date(iso).getTime()) ? "-" : new Date(iso).toLocaleTimeString();
  return (
    <span suppressHydrationWarning title={iso}>
      {label}
    </span>
  );
}

function cloneBlobDeep(blob: Blob, mimeType: string): Promise<Blob> {
  return blob.arrayBuffer().then((buffer) => new Blob([buffer], { type: mimeType }));
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`b-${idx}`}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={`i-${idx}`}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={`t-${idx}`}>{part}</Fragment>;
  });
}

function RecordControlIcon({ recording }: { recording: boolean }) {
  if (recording) {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden className="shrink-0">
        <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 1 1-10 0H5a7 7 0 0 0 6 6.92V20H8v2h8v-2h-3v-2.08A7 7 0 0 0 19 11h-2z"
      />
    </svg>
  );
}

function MarkdownLite({ content, className }: { content: string; className?: string }) {
  const lines = content.split("\n");
  return (
    <div className={className}>
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={`sp-${idx}`} className="h-2" />;
        }
        if (trimmed.startsWith("### ")) {
          return (
            <h3 key={`h3-${idx}`} className="mt-2 text-base font-semibold text-zinc-100">
              {renderInlineMarkdown(trimmed.slice(4))}
            </h3>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <h2 key={`h2-${idx}`} className="mt-2 text-lg font-semibold text-zinc-100">
              {renderInlineMarkdown(trimmed.slice(3))}
            </h2>
          );
        }
        if (trimmed.startsWith("# ")) {
          return (
            <h1 key={`h1-${idx}`} className="mt-2 text-xl font-bold text-zinc-50">
              {renderInlineMarkdown(trimmed.slice(2))}
            </h1>
          );
        }
        return (
          <p key={`p-${idx}`} className="text-sm leading-6 text-zinc-200">
            {renderInlineMarkdown(line)}
          </p>
        );
      })}
    </div>
  );
}

function buildExtendedContextTranscript(chunks: TranscriptChunk[], contextMinutes: number): string {
  const now = Date.now();
  const windowMs = contextMinutes * 60 * 1000;
  const inWindow = chunks.filter((c) => {
    const t = new Date(c.timestamp).getTime();
    if (Number.isNaN(t)) return true;
    return now - t <= windowMs;
  });
  const useChunks = inWindow.length > 0 ? inWindow : chunks;
  return [...useChunks]
    .sort((a, b) => a.chunkId - b.chunkId)
    .filter((c) => c.text.trim().length > 0)
    .map((c) => `[Chunk ${c.chunkId}] ${c.text}`.trim())
    .join("\n\n");
}

export default function Page() {
  const [isRecording, setIsRecording] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [inFlightChunks, setInFlightChunks] = useState(0);
  const [groqApiKey, setGroqApiKey] = useState("");
  const [contextMinutesSuggestions, setContextMinutesSuggestions] = useState(DEFAULT_CONTEXT_MINUTES);
  const [chatContextMinutes, setChatContextMinutes] = useState(DEFAULT_CHAT_CONTEXT_MINUTES);
  const [useExtendedContext, setUseExtendedContext] = useState(false);
  const [systemPromptChunkOnly, setSystemPromptChunkOnly] = useState("");
  const [systemPromptExtended, setSystemPromptExtended] = useState("");
  const [systemPromptChatExpand, setSystemPromptChatExpand] = useState("");
  const [systemPromptChatContinue, setSystemPromptChatContinue] = useState("");
  const [statusText, setStatusText] = useState("IDLE");
  const [transcriptHistory, setTranscriptHistory] = useState<TranscriptChunk[]>([]);
  const [suggestionBatches, setSuggestionBatches] = useState<SuggestionBatch[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatLoadingId, setChatLoadingId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [isChatContinuing, setIsChatContinuing] = useState(false);
  const [loadingChunkIds, setLoadingChunkIds] = useState<Set<number>>(() => new Set());
  const [editingChunkId, setEditingChunkId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [countdownSec, setCountdownSec] = useState<number | null>(null);

  const transcriptHistoryRef = useRef<TranscriptChunk[]>([]);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const segmentEndsAtRef = useRef<number | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const isRecordingRef = useRef(false);
  /** Monotonic segment id; never reset on new recording ? avoids duplicate chunkId / React keys. */
  const segmentIdRef = useRef(0);
  const segmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorderMimeRef = useRef<string>("audio/webm");

  useEffect(() => {
    transcriptHistoryRef.current = transcriptHistory;
  }, [transcriptHistory]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatHistory]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<TwinMindSettingsPayload>;
      if (typeof parsed.apiKey === "string") setGroqApiKey(parsed.apiKey);
      if (typeof parsed.contextMinutesSuggestions === "number") setContextMinutesSuggestions(parsed.contextMinutesSuggestions);
      if (typeof parsed.chatContextMinutes === "number") setChatContextMinutes(parsed.chatContextMinutes);
      if (typeof parsed.useExtendedContext === "boolean") setUseExtendedContext(parsed.useExtendedContext);
      if (typeof parsed.systemPromptChunkOnly === "string") setSystemPromptChunkOnly(parsed.systemPromptChunkOnly);
      if (typeof parsed.systemPromptExtended === "string") setSystemPromptExtended(parsed.systemPromptExtended);
      if (typeof parsed.systemPromptChatExpand === "string") setSystemPromptChatExpand(parsed.systemPromptChatExpand);
      if (typeof parsed.systemPromptChatContinue === "string") setSystemPromptChatContinue(parsed.systemPromptChatContinue);
    } catch {
      /* ignore corrupt storage */
    }
  }, []);

  const persistSettings = useCallback((payload: TwinMindSettingsPayload) => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota or private mode */
    }
  }, []);

  const settingsInitial = useMemo(
    (): TwinMindSettingsPayload => ({
      apiKey: groqApiKey,
      contextMinutesSuggestions,
      chatContextMinutes,
      useExtendedContext,
      systemPromptChunkOnly,
      systemPromptExtended,
      systemPromptChatExpand,
      systemPromptChatContinue,
    }),
    [
      groqApiKey,
      contextMinutesSuggestions,
      chatContextMinutes,
      useExtendedContext,
      systemPromptChunkOnly,
      systemPromptExtended,
      systemPromptChatExpand,
      systemPromptChatContinue,
    ],
  );

  useEffect(() => {
    if (!isRecording) {
      setCountdownSec(null);
      segmentEndsAtRef.current = null;
      return;
    }
    const tick = () => {
      const end = segmentEndsAtRef.current;
      if (!end) {
        setCountdownSec(null);
        return;
      }
      setCountdownSec(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [isRecording, transcriptHistory.length]);

  const canRecord = useMemo(() => Boolean(groqApiKey), [groqApiKey]);

  const flattenedTranscript = useMemo(() => {
    return [...transcriptHistory]
      .sort((a, b) => a.chunkId - b.chunkId)
      .map((chunk) => `[Chunk ${chunk.chunkId}] ${chunk.text}`.trim())
      .join("\n\n");
  }, [transcriptHistory]);

  const setChunkLoading = (chunkId: number, on: boolean) => {
    setLoadingChunkIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(chunkId);
      else next.delete(chunkId);
      return next;
    });
  };

  const appendStreamEvent = (chunkId: number, event: { delta?: string; text?: string; done?: boolean; error?: boolean }) => {
    setTranscriptHistory((current) => {
      const next = [...current];
      const index = next.findIndex((item) => item.chunkId === chunkId);
      if (index === -1) return current;

      const existing = next[index];
      const errorText = event.error ? "[Unrecognized Audio]" : undefined;
      const mergedText = typeof event.text === "string" ? event.text : `${existing.text}${event.delta ?? ""}`;
      next[index] = {
        ...existing,
        text: errorText ?? mergedText,
        isFinal: event.done ?? existing.isFinal,
      };
      return next;
    });
  };

  const fetchSuggestionsForChunk = useCallback(
    async (chunkId: number, _reason: "auto" | "manual" | "edit" | "refresh", overrideText?: string) => {
      if (!groqApiKey.trim()) return;

      const chunk = transcriptHistoryRef.current.find((c) => c.chunkId === chunkId);
      const text = (overrideText ?? chunk?.text ?? "").trim();
      if (text.length < MIN_CHARS_CHUNK_SUGGEST && !text.includes("[Unrecognized")) {
        if (_reason === "manual" || _reason === "refresh") {
          setStatusText("Need segment text before suggestions.");
        }
        return;
      }

      const extended = useExtendedContext
        ? buildExtendedContextTranscript(transcriptHistoryRef.current, contextMinutesSuggestions)
        : "";

      const body: Record<string, unknown> = {
        chunk_text: text,
        chunk_id: chunkId,
        api_key: groqApiKey,
        model: GPT_SUGGESTION_MODEL,
        use_extended_context: useExtendedContext,
        extended_context_transcript: useExtendedContext && extended.trim() ? extended : null,
        context_minutes: contextMinutesSuggestions,
      };
      if (systemPromptChunkOnly.trim()) body.system_prompt_chunk_only = systemPromptChunkOnly.trim();
      if (systemPromptExtended.trim()) body.system_prompt_extended = systemPromptExtended.trim();

      setChunkLoading(chunkId, true);
      try {
        const response = await fetch(`${BACKEND_URL}/api/suggestions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(typeof err.detail === "string" ? err.detail : "Suggestions request failed.");
        }

        const data = (await response.json()) as { batch: SuggestionBatch };
        const batch = data.batch;
        const items: SuggestionItem[] = (batch.items || []).map((row) => ({
          id: row.id,
          kind: normalizeKind(String(row.kind)),
          preview: row.preview,
          detail: row.detail,
        }));

        setSuggestionBatches((prev) => {
          const filtered = prev.filter((b) => b.triggerChunkId !== chunkId);
          return [
            {
              ...batch,
              items,
              model: batch.model || GPT_SUGGESTION_MODEL,
              triggerChunkId: chunkId,
            },
            ...filtered,
          ];
        });
        setStatusText(isRecordingRef.current ? "RECORDING" : "IDLE");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Suggestions failed.";
        setStatusText(msg);
      } finally {
        setChunkLoading(chunkId, false);
      }
    },
    [
      groqApiKey,
      contextMinutesSuggestions,
      useExtendedContext,
      systemPromptChunkOnly,
      systemPromptExtended,
    ],
  );

  const handleReloadSuggestions = useCallback(() => {
    const newest = transcriptHistoryRef.current[0];
    if (newest?.chunkId != null) {
      void fetchSuggestionsForChunk(newest.chunkId, "manual");
    }
    transcriptRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [fetchSuggestionsForChunk]);

  const handleRefreshChunkSuggestions = useCallback(
    (chunkId: number) => {
      void fetchSuggestionsForChunk(chunkId, "refresh");
    },
    [fetchSuggestionsForChunk],
  );

  const saveTranscriptEdit = useCallback(() => {
    if (editingChunkId == null) return;
    const id = editingChunkId;
    const saved = editDraft;
    setTranscriptHistory((cur) =>
      cur.map((c) => (c.chunkId === id ? { ...c, text: saved } : c)),
    );
    setEditingChunkId(null);
    setEditDraft("");
    void fetchSuggestionsForChunk(id, "edit", saved);
  }, [editingChunkId, editDraft, fetchSuggestionsForChunk]);

  const updateSuggestionText = useCallback((batchId: string, itemId: string, preview: string, detail: string) => {
    setSuggestionBatches((prev) =>
      prev.map((b) =>
        b.id !== batchId
          ? b
          : {
              ...b,
              items: b.items.map((it) => (it.id === itemId ? { ...it, preview, detail } : it)),
            },
      ),
    );
  }, []);

  const handleSuggestionClick = useCallback(
    async (item: SuggestionItem, _batch: SuggestionBatch) => {
      if (!groqApiKey.trim() || chatLoadingId) return;

      const userId = crypto.randomUUID();
      const assistantId = crypto.randomUUID();
      const now = new Date().toISOString();
      const transcriptCtx = buildExtendedContextTranscript(transcriptHistoryRef.current, chatContextMinutes);

      setChatHistory((h) => [
        ...h,
        {
          id: userId,
          role: "user",
          createdAt: now,
          content: `YOU - ANSWER: ${item.preview}`,
        },
        {
          id: assistantId,
          role: "assistant",
          createdAt: now,
          content: "...",
        },
      ]);
      setChatLoadingId(assistantId);

      try {
        const expandBody: Record<string, unknown> = {
          api_key: groqApiKey,
          model: GPT_SUGGESTION_MODEL,
          suggestion_kind: item.kind,
          suggestion_preview: item.preview,
          suggestion_detail: item.detail,
          transcript_context: transcriptCtx,
        };
        if (systemPromptChatExpand.trim()) expandBody.system_prompt = systemPromptChatExpand.trim();

        const response = await fetch(`${BACKEND_URL}/api/chat-expand`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(expandBody),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(typeof err.detail === "string" ? err.detail : "Chat expand failed.");
        }

        const data = (await response.json()) as { answer: string };
        const answer = data.answer || "";
        setChatHistory((h) => h.map((m) => (m.id === assistantId ? { ...m, content: answer } : m)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not load detail.";
        setChatHistory((h) => h.map((m) => (m.id === assistantId ? { ...m, content: msg } : m)));
      } finally {
        setChatLoadingId(null);
      }
    },
    [groqApiKey, chatContextMinutes, chatLoadingId, systemPromptChatExpand],
  );

  const handleContinueChat = useCallback(async () => {
    const message = chatInput.trim();
    if (!message || !groqApiKey.trim() || isChatContinuing) return;

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const now = new Date().toISOString();
    const transcriptCtx = buildExtendedContextTranscript(transcriptHistoryRef.current, chatContextMinutes);

    const priorConversation = chatHistory.map((m) => ({ role: m.role, content: m.content }));

    setChatHistory((h) => [
      ...h,
      { id: userId, role: "user", createdAt: now, content: message },
      { id: assistantId, role: "assistant", createdAt: now, content: "..." },
    ]);
    setChatInput("");
    setIsChatContinuing(true);

    try {
      const continueBody: Record<string, unknown> = {
        api_key: groqApiKey,
        model: GPT_SUGGESTION_MODEL,
        transcript_context: transcriptCtx,
        conversation: priorConversation,
        user_message: message,
      };
      if (systemPromptChatContinue.trim()) continueBody.system_prompt = systemPromptChatContinue.trim();

      const response = await fetch(`${BACKEND_URL}/api/chat-continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(continueBody),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(typeof err.detail === "string" ? err.detail : "Chat continue failed.");
      }

      const data = (await response.json()) as { answer: string };
      setChatHistory((h) =>
        h.map((m) => (m.id === assistantId ? { ...m, content: data.answer || "(No response text.)" } : m)),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not continue chat.";
      setChatHistory((h) => h.map((m) => (m.id === assistantId ? { ...m, content: msg } : m)));
    } finally {
      setIsChatContinuing(false);
    }
  }, [chatInput, groqApiKey, isChatContinuing, chatContextMinutes, chatHistory, systemPromptChatContinue]);

  const transcribeChunk = async (blob: Blob, chunkId: number) => {
    if (!blob.size || blob.size < MIN_CHUNK_BYTES) {
      console.info("Skipping empty/small chunk to prevent Groq processing errors.");
      return;
    }

    setInFlightChunks((value) => value + 1);
    setStatusText(`TRANSCRIBING ${chunkId}...`);

    const timestamp = new Date().toISOString();
    setTranscriptHistory((current) => [
      {
        rowId: crypto.randomUUID(),
        chunkId,
        timestamp,
        text: "",
        isFinal: false,
      },
      // Safety guard: never keep two rows for the same chunk id.
      ...current.filter((row) => row.chunkId !== chunkId),
    ]);

    transcriptRef.current?.scrollTo({ top: 0, behavior: "smooth" });

    try {
      const formData = new FormData();
      formData.append("file", blob, `segment-${Date.now()}-${chunkId}.webm`);
      formData.append("model", TRANSCRIPTION_MODEL);
      formData.append("apiKey", groqApiKey);
      formData.append("chunkId", String(chunkId));

      const response = await fetch(`${BACKEND_URL}/transcribe`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok || !response.body) {
        const errorPayload = await response.json().catch(() => ({}));
        throw new Error(errorPayload.detail ?? "Failed to transcribe chunk.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          const event = JSON.parse(line) as { delta?: string; text?: string; done?: boolean; error?: boolean };
          appendStreamEvent(chunkId, event);
        }
      }

      if (buffer.trim()) {
        const event = JSON.parse(buffer.trim()) as { delta?: string; text?: string; done?: boolean; error?: boolean };
        appendStreamEvent(chunkId, event);
      }

      setStatusText(isRecordingRef.current ? "RECORDING" : "IDLE");

      setTimeout(() => {
        void fetchSuggestionsForChunk(chunkId, "auto");
      }, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown transcription error.";
      appendStreamEvent(chunkId, { text: "[Unrecognized Audio]", done: true, error: true });
      setStatusText(`ERROR: ${message}`);
    } finally {
      setInFlightChunks((value) => Math.max(0, value - 1));
    }
  };

  const clearSegmentTimer = () => {
    if (segmentTimerRef.current !== null) {
      clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
  };

  const startNextSegment = () => {
    const stream = mediaStreamRef.current;
    if (!stream || !isRecordingRef.current) {
      return;
    }

    const mimeType = recorderMimeRef.current;
    const recorder = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = recorder;

    segmentEndsAtRef.current = Date.now() + SEGMENT_MS;

    recorder.ondataavailable = async (event: BlobEvent) => {
      if (!event.data?.size) {
        return;
      }

      if (event.data.size < MIN_CHUNK_BYTES) {
        console.info("Skipping empty/small chunk to prevent Groq processing errors.");
        return;
      }

      const freshBlob = await cloneBlobDeep(event.data, mimeType);
      segmentIdRef.current += 1;
      const id = segmentIdRef.current;
      void transcribeChunk(freshBlob, id);
    };

    recorder.onstop = () => {
      if (isRecordingRef.current) {
        startNextSegment();
      }
    };

    recorder.start();

    clearSegmentTimer();
    segmentTimerRef.current = setTimeout(() => {
      if (recorder.state === "recording") {
        recorder.stop();
      }
    }, SEGMENT_MS);
  };

  const startRecording = async () => {
    if (!canRecord || isRecordingRef.current) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported(RECORDER_MIME_TYPE) ? RECORDER_MIME_TYPE : "audio/webm";
      recorderMimeRef.current = mimeType;

      mediaStreamRef.current = stream;
      isRecordingRef.current = true;
      setIsRecording(true);
      setStatusText("RECORDING");

      startNextSegment();
    } catch {
      setStatusText("MIC ERROR");
    }
  };

  const stopRecording = () => {
    isRecordingRef.current = false;
    clearSegmentTimer();
    segmentEndsAtRef.current = null;

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.stop();
    }

    mediaRecorderRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    setIsRecording(false);
    setStatusText(inFlightChunks > 0 ? "FINALIZING..." : "STOPPED");
  };

  const toggleRecording = () => {
    if (isRecordingRef.current) {
      stopRecording();
      return;
    }

    void startRecording();
  };

  const handleExport = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      transcript: flattenedTranscript,
      transcriptHistory,
      suggestionBatches,
      chatHistory,
      contextMinutesSuggestions,
      chatContextMinutes,
      useExtendedContext,
      systemPromptChunkOnly: systemPromptChunkOnly.trim() || undefined,
      systemPromptExtended: systemPromptExtended.trim() || undefined,
      systemPromptChatExpand: systemPromptChatExpand.trim() || undefined,
      systemPromptChatContinue: systemPromptChatContinue.trim() || undefined,
    };

    const serialized = JSON.stringify(payload, null, 2);
    const blob = new Blob([serialized], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `twinmind-assessment-${Date.now()}.json`;
    anchor.click();

    URL.revokeObjectURL(url);
  };

  const anySuggestionLoading = loadingChunkIds.size > 0;

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-[#0f1419] text-zinc-100">
      <SettingsModal
        isOpen={isSettingsOpen}
        initial={settingsInitial}
        onSave={(payload) => {
          setGroqApiKey(payload.apiKey);
          setContextMinutesSuggestions(payload.contextMinutesSuggestions);
          setChatContextMinutes(payload.chatContextMinutes);
          setUseExtendedContext(payload.useExtendedContext);
          setSystemPromptChunkOnly(payload.systemPromptChunkOnly);
          setSystemPromptExtended(payload.systemPromptExtended);
          setSystemPromptChatExpand(payload.systemPromptChatExpand);
          setSystemPromptChatContinue(payload.systemPromptChatContinue);
          persistSettings(payload);
        }}
        onClose={() => setIsSettingsOpen(false)}
      />

      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/95 px-4 backdrop-blur">
        <span className="text-sm font-semibold tracking-tight text-zinc-100">TwinMind</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="rounded-md border border-zinc-600 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            Settings
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white"
          >
            Export
          </button>
        </div>
      </header>

      <section className="grid min-h-0 flex-1 grid-cols-3 gap-3 p-3">
        {/* 1. Transcript */}
        <div className="flex min-h-0 flex-col rounded-xl border border-zinc-700 bg-zinc-900/80 p-3">
          <div className="flex shrink-0 items-center justify-between gap-2">
            <h2 className="text-xs font-bold uppercase tracking-wide text-zinc-300">1. Mic & Transcript</h2>
            <span className="rounded border border-zinc-600 px-2 py-0.5 text-[10px] font-mono text-zinc-400">{statusText}</span>
          </div>
          <p className="mt-2 rounded border border-zinc-700/80 bg-zinc-950/50 p-2 text-[11px] leading-relaxed text-zinc-500">
            Transcript scrolls here; new ~30s segments appear at the <strong className="text-zinc-400">top</strong>. Edit any
            chunk to fix ASR mistakes - suggestions for that chunk regenerate automatically.
          </p>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={toggleRecording}
              disabled={!canRecord}
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 text-lg transition-transform active:scale-95 disabled:opacity-40 ${
                isRecording ? "border-sky-500 bg-sky-600 text-white" : "border-zinc-500 bg-zinc-800 text-zinc-300"
              }`}
              aria-label={isRecording ? "Stop recording" : "Start recording"}
            >
              <RecordControlIcon recording={isRecording} />
            </button>
            <p className="text-xs text-zinc-400">
              {isRecording ? "Recording. Next segment boundary ~30s." : "Stopped. Click to record."}
            </p>
          </div>

          {!canRecord ? <p className="mt-2 text-[11px] text-amber-400/90">Set GROQ_API_KEY in Settings.</p> : null}

          <div
            ref={transcriptRef}
            className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-sm"
          >
            {transcriptHistory.length === 0 ? (
              <p className="text-xs text-zinc-500">No segments yet.</p>
            ) : (
              transcriptHistory.map((chunk) => (
                <article key={chunk.rowId} className="mb-3 border-b border-zinc-800/80 pb-3 last:mb-0 last:border-0">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <p className="text-[10px] text-zinc-500">
                      <ClientLocalTime iso={chunk.timestamp} />
                      {chunk.isFinal ? "" : " - streaming"}
                    </p>
                    <div className="flex gap-1">
                      {editingChunkId === chunk.chunkId ? (
                        <>
                          <button
                            type="button"
                            onClick={saveTranscriptEdit}
                            className="rounded bg-emerald-700/80 px-2 py-0.5 text-[10px] text-white"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingChunkId(null);
                              setEditDraft("");
                            }}
                            className="rounded border border-zinc-600 px-2 py-0.5 text-[10px] text-zinc-400"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingChunkId(chunk.chunkId);
                            setEditDraft(chunk.text);
                          }}
                          className="rounded border border-zinc-600 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                  {editingChunkId === chunk.chunkId ? (
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={5}
                      className="mt-2 w-full resize-y rounded border border-zinc-600 bg-zinc-900 p-2 text-xs text-zinc-100"
                    />
                  ) : (
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-zinc-200">{chunk.text || "..."}</p>
                  )}
                </article>
              ))
            )}
          </div>
        </div>

        {/* 2. Suggestions */}
        <div className="flex min-h-0 flex-col rounded-xl border border-zinc-700 bg-zinc-900/80 p-3">
          <div className="flex shrink-0 items-start justify-between gap-2">
            <div>
              <h2 className="text-xs font-bold uppercase tracking-wide text-zinc-300">2. Live Suggestions</h2>
              <p className="mt-0.5 text-[10px] text-zinc-500">
                {suggestionBatches.length} batch{suggestionBatches.length === 1 ? "" : "es"} - newest first
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <button
                type="button"
                disabled={!groqApiKey || anySuggestionLoading}
                onClick={handleReloadSuggestions}
                className="rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-[10px] text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
              >
                {anySuggestionLoading ? "Loading..." : "Reload suggestions"}
              </button>
              {isRecording && countdownSec != null ? (
                <span className="text-[10px] text-zinc-500">Next segment ~{countdownSec}s</span>
              ) : null}
            </div>
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-2">
            {suggestionBatches.length === 0 ? (
              <p className="text-xs text-zinc-500">Each completed segment generates 3 suggestions (chunk-only unless extended context is on in Settings).</p>
            ) : (
              <ul className="space-y-5">
                {suggestionBatches.map((batch) => {
                  const cid = batch.triggerChunkId;
                  const busy = cid != null && loadingChunkIds.has(cid);
                  return (
                    <li key={batch.id} className="tm-fade-in border-b border-zinc-800/90 pb-5 last:border-0">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                          Batch - <ClientLocalTime iso={batch.createdAt} />
                          {cid != null ? ` - chunk ${cid}` : ""}
                        </p>
                        {cid != null ? (
                          <button
                            type="button"
                            disabled={!groqApiKey || busy}
                            onClick={() => handleRefreshChunkSuggestions(cid)}
                            className="rounded border border-zinc-600 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
                          >
                            {busy ? "..." : "Refresh chunk"}
                          </button>
                        ) : null}
                      </div>
                      <ul className="space-y-2">
                        {batch.items.map((item) => (
                          <li
                            key={item.id}
                            className="rounded-lg border border-zinc-700/90 bg-zinc-900/90 p-2 shadow-sm"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <span
                                className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${KIND_TAG_CLASS[item.kind]}`}
                              >
                                {KIND_TAG[item.kind]}
                              </span>
                              <div className="flex gap-1">
                                <button
                                  type="button"
                                  onClick={() => void handleSuggestionClick(item, batch)}
                                  disabled={!!chatLoadingId}
                                  className="text-[10px] text-sky-400 hover:underline disabled:opacity-40"
                                >
                                  Open in chat
                                </button>
                              </div>
                            </div>
                            <label className="mt-2 block text-[10px] text-zinc-500">Preview</label>
                            <textarea
                              value={item.preview}
                              onChange={(e) => updateSuggestionText(batch.id, item.id, e.target.value, item.detail)}
                              rows={2}
                              className="mt-0.5 w-full resize-y rounded border border-zinc-700 bg-zinc-950/80 p-1.5 text-xs text-zinc-100"
                            />
                            <label className="mt-2 block text-[10px] text-zinc-500">Detail</label>
                            <textarea
                              value={item.detail}
                              onChange={(e) => updateSuggestionText(batch.id, item.id, item.preview, e.target.value)}
                              rows={3}
                              className="mt-0.5 w-full resize-y rounded border border-zinc-700 bg-zinc-950/80 p-1.5 text-xs text-zinc-100"
                            />
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* 3. Chat */}
        <div className="flex min-h-0 flex-col rounded-xl border border-zinc-700 bg-zinc-900/80 p-3">
          <div className="flex shrink-0 items-center justify-between gap-2">
            <h2 className="text-xs font-bold uppercase tracking-wide text-zinc-300">3. Chat (detailed answers)</h2>
            <span className="rounded border border-amber-600/40 bg-amber-950/40 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200/90">
              Session-only
            </span>
          </div>
          <p className="mt-2 rounded border border-zinc-700/80 bg-zinc-950/50 p-2 text-[11px] leading-relaxed text-zinc-500">
            Tap &quot;Open in chat&quot; on a suggestion for a longer answer. Content is not persisted beyond this session
            unless you export.
          </p>
          <div
            ref={chatScrollRef}
            className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 text-sm"
          >
            {chatHistory.length === 0 ? (
              <p className="text-xs text-zinc-500">No messages yet.</p>
            ) : (
              chatHistory.map((message) => (
                <article
                  key={message.id}
                  className={`mb-3 rounded-lg border p-2 text-xs ${
                    message.role === "user" ? "border-sky-800/50 bg-sky-950/30" : "border-zinc-700 bg-zinc-900/80"
                  }`}
                >
                  <p className="text-[10px] font-bold uppercase text-zinc-500">
                    {message.role === "user" ? "You" : "Assistant"}
                  </p>
                  <p className="mt-0.5 text-[10px] text-zinc-600">
                    <ClientLocalTime iso={message.createdAt} />
                  </p>
                  {message.role === "assistant" ? (
                    <MarkdownLite content={message.content} className="mt-2" />
                  ) : (
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-200">{message.content}</p>
                  )}
                </article>
              ))
            )}
          </div>
          <div className="mt-3 shrink-0 rounded-lg border border-zinc-800 bg-zinc-950/70 p-2">
            <div className="flex gap-2">
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Continue the thought here..."
                rows={2}
                className="min-h-[52px] flex-1 resize-y rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
              />
              <button
                type="button"
                disabled={!groqApiKey || !chatInput.trim() || isChatContinuing}
                onClick={() => void handleContinueChat()}
                className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isChatContinuing ? "Sending..." : "Send"}
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
