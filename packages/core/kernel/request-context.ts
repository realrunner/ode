import type { InboundAttachment } from "@/core/model/inbound-attachment";

export type RuntimeRequestContext = {
  channelId: string;
  rawChannelId?: string;
  replyThreadId: string;
  threadId: string;
  userId: string;
  messageId: string;
  botToken?: string;
  attachments?: readonly InboundAttachment[];
};
