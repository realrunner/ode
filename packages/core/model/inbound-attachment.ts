export type InboundAttachment = Readonly<{
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  localPath: string;
}>;
