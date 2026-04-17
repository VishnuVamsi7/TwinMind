export type SuggestionKind = "question" | "talking_point" | "answer" | "fact_check" | "clarify";

export type SuggestionItem = {
  id: string;
  kind: SuggestionKind;
  preview: string;
  detail: string;
};

export type SuggestionBatch = {
  id: string;
  createdAt: string;
  model: string;
  triggerChunkId?: number;
  items: SuggestionItem[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  content: string;
};

export type TranscriptChunk = {
  /** Stable id for React lists (never reuse across sessions). */
  rowId: string;
  chunkId: number;
  timestamp: string;
  text: string;
  isFinal: boolean;
};
