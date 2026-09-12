import type { PostMutateContext, PostMutateHook, PostMutateResult } from "./tool-context.ts";

/** Result of running a `postMutate` hook, with hook failures degraded to a warning note. */
export interface PostMutateOutcome {
	/**
	 * Whether the file may differ from the bytes the tool itself wrote. True when the hook reported
	 * a change, and also when the hook rejected — a hook that fails midway can leave the file
	 * partially rewritten, so callers must re-read rather than trust their own bytes.
	 */
	fileMayHaveChanged: boolean;
	note?: string;
}

const NO_CHANGE: PostMutateOutcome = { fileMayHaveChanged: false };

/**
 * Run a `postMutate` hook after a write has already landed on disk.
 *
 * The write is committed by the time the hook runs, so a rejecting hook must not fail the tool
 * call and lose that result. Hook failures are reported as an appended warning note instead.
 */
export async function runPostMutate(
	hook: PostMutateHook | undefined,
	input: PostMutateContext,
): Promise<PostMutateOutcome> {
	if (!hook) return NO_CHANGE;
	let result: PostMutateResult;
	try {
		result = await hook(input);
	} catch (error) {
		return { fileMayHaveChanged: true, note: `postMutate hook failed: ${errorMessage(error)}` };
	}
	return { fileMayHaveChanged: result.changed, note: result.note };
}

/** Append any `postMutate` notes to tool result text, one per line, skipping absent ones. */
export function appendPostMutateNote(text: string, ...notes: Array<string | undefined>): string {
	return [text, ...notes.filter((note) => note !== undefined)].join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
