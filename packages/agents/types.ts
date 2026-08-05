import type { InboundAttachment } from "@/core/model/inbound-attachment";

export interface OpenCodeMessage {
  text: string;
  messageType: "assistant" | "result" | "system" | "user" | "notify";
}

export interface OpenCodeOptions {
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

export interface PlatformContext {
  platform?: "slack" | "discord" | "lark";
  channelId: string;
  threadId: string;
  userId: string;
  threadHistory?: string;
  hasGitHubToken?: boolean;
  channelSystemMessage?: string;
}

// Backward-compatible alias: OpenCode transport still expects `slack` key.
export type SlackContext = PlatformContext;

export interface OpenCodeMessageContext {
  threadHistory?: string;
  slack?: PlatformContext;
  attachments?: readonly InboundAttachment[];
}

export interface OpenCodeSessionInfo {
  sessionId: string;
  created: boolean;
}

export type PromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename: string; url: string };
