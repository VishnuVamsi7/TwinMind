"use client";

import { startTransition, useEffect, useState } from "react";

export type TwinMindSettingsPayload = {
  apiKey: string;
  contextMinutesSuggestions: number;
  chatContextMinutes: number;
  useExtendedContext: boolean;
  systemPromptChunkOnly: string;
  systemPromptExtended: string;
  systemPromptChatExpand: string;
  systemPromptChatContinue: string;
};

type SettingsModalProps = {
  isOpen: boolean;
  initial: TwinMindSettingsPayload;
  onSave: (payload: TwinMindSettingsPayload) => void;
  onClose: () => void;
};

const DEFAULT_SUGGESTION_CTX = 8;
const DEFAULT_CHAT_CTX = 120;

export function SettingsModal({ isOpen, initial, onSave, onClose }: SettingsModalProps) {
  const [apiKeyInput, setApiKeyInput] = useState(initial.apiKey);
  const [suggestionCtxInput, setSuggestionCtxInput] = useState(String(initial.contextMinutesSuggestions));
  const [chatCtxInput, setChatCtxInput] = useState(String(initial.chatContextMinutes));
  const [extendedInput, setExtendedInput] = useState(initial.useExtendedContext);
  const [promptChunk, setPromptChunk] = useState(initial.systemPromptChunkOnly);
  const [promptExtended, setPromptExtended] = useState(initial.systemPromptExtended);
  const [promptExpand, setPromptExpand] = useState(initial.systemPromptChatExpand);
  const [promptContinue, setPromptContinue] = useState(initial.systemPromptChatContinue);

  useEffect(() => {
    if (!isOpen) return;
    startTransition(() => {
      setApiKeyInput(initial.apiKey);
      setSuggestionCtxInput(String(initial.contextMinutesSuggestions));
      setChatCtxInput(String(initial.chatContextMinutes));
      setExtendedInput(initial.useExtendedContext);
      setPromptChunk(initial.systemPromptChunkOnly);
      setPromptExtended(initial.systemPromptExtended);
      setPromptExpand(initial.systemPromptChatExpand);
      setPromptContinue(initial.systemPromptChatContinue);
    });
  }, [isOpen, initial]);

  if (!isOpen) {
    return null;
  }

  const clampMinutes = (raw: string, fallback: number, max: number) => {
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(1, parsed));
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
        <div className="shrink-0 border-b border-zinc-800 p-6 pb-4">
          <h2 className="text-xl font-semibold text-zinc-100">Settings</h2>
          <p className="mt-2 text-sm text-zinc-400">
            Groq API key, separate transcript windows for suggestions vs chat, and optional system prompt overrides. Leave
            prompt fields blank to use the server&apos;s built-in TwinMind defaults. Nothing is sent to our servers except
            your browser&apos;s calls to your configured backend, which forwards to Groq.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <div className="mt-4">
            <label htmlFor="groq-key" className="mb-2 block text-sm font-medium text-zinc-200">
              GROQ_API_KEY
            </label>
            <input
              id="groq-key"
              type="password"
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.target.value)}
              placeholder="gsk_..."
              className="w-full rounded-md border border-zinc-600 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
            />
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="ctx-suggestions" className="mb-2 block text-sm font-medium text-zinc-200">
                Suggestions rolling window (minutes)
              </label>
              <p className="mb-2 text-xs leading-relaxed text-zinc-500">
                Used only when &quot;Extended context&quot; is on: extra transcript for disambiguation while anchoring on
                the latest ~30s segment. Range 1–120.
              </p>
              <input
                id="ctx-suggestions"
                type="number"
                min={1}
                max={120}
                value={suggestionCtxInput}
                onChange={(event) => setSuggestionCtxInput(event.target.value)}
                className="w-full rounded-md border border-zinc-600 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
              />
            </div>
            <div>
              <label htmlFor="ctx-chat" className="mb-2 block text-sm font-medium text-zinc-200">
                Chat grounding window (minutes)
              </label>
              <p className="mb-2 text-xs leading-relaxed text-zinc-500">
                Recent transcript passed when you open a card in chat or continue the thread. Independent of the
                suggestions window. Range 1–1440 (24h).
              </p>
              <input
                id="ctx-chat"
                type="number"
                min={1}
                max={1440}
                value={chatCtxInput}
                onChange={(event) => setChatCtxInput(event.target.value)}
                className="w-full rounded-md border border-zinc-600 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div className="mt-5 flex items-start gap-3 rounded-lg border border-zinc-700 bg-zinc-950/80 p-3">
            <input
              id="extended-ctx"
              type="checkbox"
              checked={extendedInput}
              onChange={(e) => setExtendedInput(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-zinc-600"
            />
            <div>
              <label htmlFor="extended-ctx" className="text-sm font-medium text-zinc-200">
                Extended context for live suggestions
              </label>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                Off: each batch uses <strong className="text-zinc-300">only that 30s chunk&apos;s text</strong>. On: the model
                still anchors on that chunk, but may read the rolling suggestions window above for names and threads.
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-4 border-t border-zinc-800 pt-6">
            <h3 className="text-sm font-semibold text-zinc-200">System prompts (optional overrides)</h3>
            <p className="text-xs leading-relaxed text-zinc-500">
              Override the model&apos;s system instructions. Empty = default. You are responsible for keeping JSON output
              rules if you edit the live-suggestion prompts.
            </p>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">
                Live suggestions — chunk-only mode
              </label>
              <textarea
                value={promptChunk}
                onChange={(e) => setPromptChunk(e.target.value)}
                rows={5}
                placeholder="Blank = server default (strict JSON, exactly 3 suggestions, …)"
                className="w-full resize-y rounded-md border border-zinc-600 bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-200 outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">
                Live suggestions — extended mode
              </label>
              <textarea
                value={promptExtended}
                onChange={(e) => setPromptExtended(e.target.value)}
                rows={5}
                placeholder="Blank = server default (primary segment + optional reference window, …)"
                className="w-full resize-y rounded-md border border-zinc-600 bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-200 outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">
                Detailed answer (suggestion tap → chat)
              </label>
              <textarea
                value={promptExpand}
                onChange={(e) => setPromptExpand(e.target.value)}
                rows={4}
                placeholder="Blank = server default (TwinMind Chat, concise substantive answer, …)"
                className="w-full resize-y rounded-md border border-zinc-600 bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-200 outline-none focus:border-sky-500"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">
                Copilot chat (continue thread)
              </label>
              <textarea
                value={promptContinue}
                onChange={(e) => setPromptContinue(e.target.value)}
                rows={4}
                placeholder="Blank = server default (markdown-friendly copilot, …)"
                className="w-full resize-y rounded-md border border-zinc-600 bg-zinc-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-200 outline-none focus:border-sky-500"
              />
            </div>
          </div>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-zinc-800 bg-zinc-900/95 p-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-600 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onSave({
                apiKey: apiKeyInput.trim(),
                contextMinutesSuggestions: clampMinutes(suggestionCtxInput, DEFAULT_SUGGESTION_CTX, 120),
                chatContextMinutes: clampMinutes(chatCtxInput, DEFAULT_CHAT_CTX, 1440),
                useExtendedContext: extendedInput,
                systemPromptChunkOnly: promptChunk,
                systemPromptExtended: promptExtended,
                systemPromptChatExpand: promptExpand,
                systemPromptChatContinue: promptContinue,
              });
              onClose();
            }}
            className="rounded-md bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
