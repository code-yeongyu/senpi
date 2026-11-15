import type { BuildDynamicSystemPromptOptions } from "../../core/dynamic-prompt/build.ts";
import type { PromptSurface, SharedSections } from "../../core/dynamic-prompt/types.ts";
import type { WorkstationDialect } from "../../core/dynamic-prompt/workstation.ts";
import type { BuildSystemPromptOptions } from "../../core/system-prompt.ts";
import { z } from "zod";

// The prompt options a forwarded before_agent_start carries are the loop's options as its session built them: every
// field either options type names that survives JSON (the functions `onParts` and `corePrompt` never do). They are a
// part the loop-hook lane defines, so they are strict: a field neither type names is refused. The context files and
// skills inside them are the loop's own records and stay loose, as transcript messages do (agent-message-schema.ts).

type WireField = Exclude<
	keyof BuildSystemPromptOptions | keyof BuildDynamicSystemPromptOptions,
	"onParts" | "corePrompt"
>;

const SURFACES = ["terminal", "app", "chat"] as const satisfies readonly PromptSurface[];
const SHARED_SECTIONS = ["full", "diet"] as const satisfies readonly SharedSections[];
const DIALECTS = ["default", "claude", "codex", "kimi", "gemini"] as const satisfies readonly WorkstationDialect[];

const strings = z.array(z.string());
const stringRecord = z.record(z.string(), z.string());

const SHAPE = {
	// Optional on the wire: the hand replaces the loop's working directory with its own workspace.
	cwd: z.string().optional(),
	customPrompt: z.string().optional(),
	forceSystemPrompt: z.string().optional(),
	selectedTools: strings.optional(),
	toolSnippets: stringRecord.optional(),
	toolGuidelines: z.record(z.string(), strings).optional(),
	promptGuidelines: strings.optional(),
	appendSystemPrompt: z.string().optional(),
	sections: stringRecord.optional(),
	contextFiles: z.array(z.looseObject({ path: z.string(), content: z.string() })).optional(),
	skills: z
		.array(z.looseObject({ name: z.string(), description: z.string(), filePath: z.string(), baseDir: z.string() }))
		.optional(),
	surface: z.enum(SURFACES).optional(),
	appName: z.string().optional(),
	nativeSearchAvailable: z.boolean().optional(),
	fullToolPrompt: z.strictObject({ toolSnippets: stringRecord, promptGuidelines: strings }).optional(),
	sharedSections: z.enum(SHARED_SECTIONS).optional(),
	tuningSection: z.string().optional(),
	workstationDialect: z.enum(DIALECTS).optional(),
} satisfies { [K in WireField]: z.ZodType };

const systemPromptOptionsSchema = z.strictObject(SHAPE);

/** The loop's prompt options as they cross the link: `cwd` may be absent, since the hand supplies its own. */
export type WireSystemPromptOptions = Omit<BuildSystemPromptOptions, "cwd"> & { readonly cwd?: string };

const isSystemPromptOptions = (value: unknown): value is WireSystemPromptOptions =>
	systemPromptOptionsSchema.safeParse(value).success;

/** The forwarded prompt options, or `undefined` when malformed. */
export const systemPromptOptionsOf = (value: unknown): WireSystemPromptOptions | undefined =>
	isSystemPromptOptions(value) ? value : undefined;
