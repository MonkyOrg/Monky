import { z } from 'zod';
import type { IpcInvokeChannels } from './ipc.js';

/** Several attachments saved at once: each into a chosen folder, or together in one ZIP. */
export const FILE_BATCH_DOWNLOAD_IPC = 'app:download-files' satisfies keyof IpcInvokeChannels;
export const FILE_BATCH_DOWNLOAD_MAX_FILES = 200;

export const fileBatchDownloadModeSchema = z.enum(['folder', 'zip']);
export type FileBatchDownloadMode = z.infer<typeof fileBatchDownloadModeSchema>;

const fileNameSchema = z.string().min(1).max(255);

/** A server attachment by URL, or a DM attachment kept by the main process. */
export const fileBatchDownloadFileSchema = z.union([
  z.object({
    url: z.string().max(4096).refine((value) => {
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }),
    fileName: fileNameSchema,
  }).strict(),
  z.object({
    dm: z.object({
      peer: z.string().min(1).max(256),
      messageId: z.string().min(1).max(128),
      fileId: z.string().min(1).max(128),
    }).strict(),
    fileName: fileNameSchema,
  }).strict(),
]);
export type FileBatchDownloadFile = z.infer<typeof fileBatchDownloadFileSchema>;

export const fileBatchDownloadRequestSchema = z.object({
  mode: fileBatchDownloadModeSchema,
  /** Suggested ZIP name, without the extension. */
  archiveName: z.string().trim().min(1).max(128),
  files: z.array(fileBatchDownloadFileSchema).min(1).max(FILE_BATCH_DOWNLOAD_MAX_FILES),
});
export type FileBatchDownloadRequest = z.infer<typeof fileBatchDownloadRequestSchema>;

export type FileBatchDownloadResult =
  | { status: 'saved'; saved: number }
  | { status: 'cancelled' }
  /** `saved` counts what still reached the disk: a folder keeps the files that finished, a ZIP keeps none. */
  | { status: 'failed'; saved: number; error: string };
