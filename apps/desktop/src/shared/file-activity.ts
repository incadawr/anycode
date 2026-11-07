import { z } from 'zod';

const bounded = (max: number) => z.string().min(1).max(max).refine(value => !value.includes('\0'));
export const reportedWriteSchema = z.object({
  filePath: bounded(4096), toolCallId: bounded(256),
  toolName: z.enum(['Edit', 'Write', 'NotebookEdit']),
}).strict();
export const fileActivitySchema = z.object({
  type: z.literal('file_activity'), generation: z.number().int().nonnegative(),
  report: reportedWriteSchema,
}).strict();
export type ReportedWrite = z.infer<typeof reportedWriteSchema>;
export const shellActivitySchema = z.object({
  type: z.literal('shell_activity'), generation: z.number().int().nonnegative(),
  phase: z.enum(['start', 'end']), toolCallId: bounded(256),
}).strict();
export type FileActivityMessage = z.infer<typeof fileActivitySchema> | z.infer<typeof shellActivitySchema>;
