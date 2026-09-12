import type { EvalLanguage, KernelInterruptHandle } from "./types.ts";

const TIMEOUT_STATE_GRACE_MS = 5_500;

function fallbackTimeoutMessage(base: string): string {
	return `${base} Kernel state may have been lost; re-establish any variables the next cell needs.`;
}

/**
 * Appends the kernel's actual post-timeout state to a TimeoutError, waiting a
 * bounded window for the interrupt outcome so the model knows whether its
 * variables survived. Falls back to an honest unknown when no outcome arrives.
 */
export async function describeTimeoutState(
	error: Error,
	execution: { readonly interruptHandle: Promise<KernelInterruptHandle> | undefined },
): Promise<Error> {
	const pending = execution.interruptHandle;
	if (pending === undefined) {
		error.message = fallbackTimeoutMessage(error.message);
		return error;
	}
	const outcome = await withinGrace(
		pending.then(async (handle) => ({ retained: await handle.stateRetained, note: handle.note })),
		TIMEOUT_STATE_GRACE_MS,
	);
	if (outcome === undefined) error.message = fallbackTimeoutMessage(error.message);
	else if (outcome.retained)
		error.message = `${error.message} The kernel remains running; its existing variables are preserved.`;
	else
		error.message = `${error.message} The kernel was unresponsive and restarted; variables from earlier cells are lost.`;
	if (outcome?.note !== undefined) error.message = `${error.message} ${outcome.note.trim()}`;
	return error;
}

async function withinGrace<T>(operation: Promise<T>, graceMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), graceMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

const LANGUAGE_LABEL: Record<EvalLanguage, string> = {
	py: "Python kernel",
	js: "JavaScript worker",
	rb: "Ruby kernel",
	jl: "Julia kernel",
};

/**
 * Composes the user-facing note for a cancelled eval cell from the interrupt
 * outcome the kernel actually reported — never a per-language assumption.
 *
 * Returns undefined when there is nothing truthful to add (no interrupt ran).
 */
export function interruptionStateNote(language: EvalLanguage, stateRetained: boolean | undefined): string | undefined {
	if (stateRetained === undefined) return undefined;
	const label = LANGUAGE_LABEL[language];
	if (stateRetained) return `${label} was interrupted and remains running; its existing variables are preserved.`;
	return `${label} was unresponsive to interrupt and was restarted; variables from earlier cells are lost.`;
}

export function unknownInterruptionStateNote(language: EvalLanguage): string {
	return `${LANGUAGE_LABEL[language]} interrupt outcome is unknown; re-establish any variables the next cell needs.`;
}
