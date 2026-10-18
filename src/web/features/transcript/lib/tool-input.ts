import { z } from 'zod';

/**
 * Tolerant readers for tool inputs and `tool_use_result` shapes (CLAUDE.md "zod an jeder Grenze";
 * shapes from docs/sdk-findings.md Punkt 4/5/6/11). Unknown keys are ignored; a reader returns
 * null when the shape does not fit (the renderer then falls back to the generic view). Remember:
 * `result.structured` is null in the history (A.3) – renderers never rely on it alone.
 */

export type Reader<T> = (value: unknown) => T | null;

/** `schema.safeParse(value)` → data or null; results are cached per input object. */
export function reader<T>(schema: z.ZodType<T>): Reader<T> {
  const cache = new WeakMap<object, T | null>();
  return (value) => {
    if (typeof value !== 'object' || value === null) {
      const result = schema.safeParse(value);
      return result.success ? result.data : null;
    }
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    const result = schema.safeParse(value);
    const data = result.success ? result.data : null;
    cache.set(value, data);
    return data;
  };
}

// ---- Bash / PowerShell ----

export const shellInputSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
  run_in_background: z.boolean().optional(),
  timeout: z.number().optional(),
});
export type ShellInput = z.infer<typeof shellInputSchema>;

/** stdout/stderr are removed by the normalizer when they are already in `content` (R0-11). */
export const shellResultSchema = z.object({
  interrupted: z.boolean().optional(),
  isImage: z.boolean().optional(),
  noOutputExpected: z.boolean().optional(),
  backgroundTaskId: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
});
export type ShellResult = z.infer<typeof shellResultSchema>;

// ---- Edit / MultiEdit / Write ----

export const editInputSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});
export type EditInput = z.infer<typeof editInputSchema>;

export const multiEditInputSchema = z.object({
  file_path: z.string(),
  edits: z.array(
    z.object({ old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
  ),
});
export type MultiEditInput = z.infer<typeof multiEditInputSchema>;

export const writeInputSchema = z.object({ file_path: z.string(), content: z.string() });
export type WriteInput = z.infer<typeof writeInputSchema>;

export const hunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});
export type Hunk = z.infer<typeof hunkSchema>;

/** Edit and Write results: `{ type?: 'create'|'update', structuredPatch, originalFile … }`. */
export const patchResultSchema = z.object({
  type: z.string().optional(),
  structuredPatch: z.array(hunkSchema).optional(),
  userModified: z.boolean().optional(),
});
export type PatchResult = z.infer<typeof patchResultSchema>;

// ---- Read ----

export const readInputSchema = z.object({
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  pages: z.string().optional(),
});
export type ReadInput = z.infer<typeof readInputSchema>;

export const readResultSchema = z.object({
  type: z.string().optional(),
  file: z
    .object({
      filePath: z.string().optional(),
      numLines: z.number().optional(),
      startLine: z.number().optional(),
      totalLines: z.number().optional(),
    })
    .optional(),
});
export type ReadResult = z.infer<typeof readResultSchema>;

/** Any tool input with a file path (Read, Edit, Write, NotebookEdit …) – names result images. */
export const filePathInputSchema = z.object({ file_path: z.string() });

// ---- Grep / Glob ----

export const grepInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  type: z.string().optional(),
  output_mode: z.string().optional(),
});
export type GrepInput = z.infer<typeof grepInputSchema>;

export const globInputSchema = z.object({ pattern: z.string(), path: z.string().optional() });
export type GlobInput = z.infer<typeof globInputSchema>;

export const searchResultSchema = z.object({
  mode: z.string().optional(),
  filenames: z.array(z.string()).optional(),
  numFiles: z.number().optional(),
  numLines: z.number().optional(),
  numMatches: z.number().optional(),
  truncated: z.boolean().optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

// ---- Agent ----

export const agentInputSchema = z.object({
  description: z.string().optional(),
  prompt: z.string().optional(),
  subagent_type: z.string().optional(),
  model: z.string().optional(),
});
export type AgentInput = z.infer<typeof agentInputSchema>;

export const agentResultSchema = z.object({
  status: z.string().optional(),
  resolvedModel: z.string().optional(),
  isAsync: z.boolean().optional(),
});
export type AgentResult = z.infer<typeof agentResultSchema>;

// ---- ExitPlanMode (F.6: `plan`/`planFilePath` injected by the CLI) ----

export const planInputSchema = z.object({
  plan: z.string().optional(),
  planFilePath: z.string().optional(),
});
export type PlanInput = z.infer<typeof planInputSchema>;

/** Live result after an approval: `{ plan, filePath, planWasEdited }` (approved text, F.6). */
export const planResultSchema = z.object({
  plan: z.string().optional(),
  planWasEdited: z.boolean().optional(),
});
export type PlanResult = z.infer<typeof planResultSchema>;

// ---- AskUserQuestion (F.5) ----

export const questionInputSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string().optional(),
      multiSelect: z.boolean().optional(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
    }),
  ),
});
export type QuestionInput = z.infer<typeof questionInputSchema>;

export const questionResultSchema = z.object({
  answers: z.record(z.string(), z.string()).optional(),
  annotations: z.record(z.string(), z.object({ notes: z.string().optional() })).optional(),
});
export type QuestionResult = z.infer<typeof questionResultSchema>;

// ---- Web ----

export const webFetchInputSchema = z.object({ url: z.string(), prompt: z.string().optional() });
export const webSearchInputSchema = z.object({ query: z.string() });

// ---- TodoWrite ----

export const todoInputSchema = z.object({
  todos: z.array(
    z.object({
      content: z.string(),
      status: z.string(),
      activeForm: z.string().optional(),
    }),
  ),
});
export type TodoInput = z.infer<typeof todoInputSchema>;

// ---- readers (one cache per schema) ----

export const readShellInput = reader(shellInputSchema);
export const readShellResult = reader(shellResultSchema);
export const readEditInput = reader(editInputSchema);
export const readMultiEditInput = reader(multiEditInputSchema);
export const readWriteInput = reader(writeInputSchema);
export const readPatchResult = reader(patchResultSchema);
export const readReadInput = reader(readInputSchema);
export const readReadResult = reader(readResultSchema);
export const readFilePathInput = reader(filePathInputSchema);
export const readGrepInput = reader(grepInputSchema);
export const readGlobInput = reader(globInputSchema);
export const readSearchResult = reader(searchResultSchema);
export const readAgentInput = reader(agentInputSchema);
export const readAgentResult = reader(agentResultSchema);
export const readPlanInput = reader(planInputSchema);
export const readPlanResult = reader(planResultSchema);
export const readQuestionInput = reader(questionInputSchema);
export const readQuestionResult = reader(questionResultSchema);
export const readWebFetchInput = reader(webFetchInputSchema);
export const readWebSearchInput = reader(webSearchInputSchema);
export const readTodoInput = reader(todoInputSchema);
