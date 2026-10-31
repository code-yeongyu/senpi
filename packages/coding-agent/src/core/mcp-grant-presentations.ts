import type { ExtensionUIDialogOptions } from "./extensions/types.ts";

type Select = (title: string, options: string[], opts?: ExtensionUIDialogOptions) => Promise<string | undefined>;
interface Presentation {
	readonly select: Select;
	readonly abort: AbortController;
}
const presentations = new Map<string, Set<Presentation>>();

/** Each RPC connection registers only if its own handshake advertises grant_select. */
export function attachMcpGrantPresentation(sessionId: string, select: Select): () => void {
	const attached = presentations.get(sessionId) ?? new Set<Presentation>();
	presentations.set(sessionId, attached);
	const abort = new AbortController();
	const entry: Presentation = {
		abort,
		select: (title, choices, opts) =>
			select(title, choices, {
				...opts,
				signal: opts?.signal === undefined ? abort.signal : AbortSignal.any([opts.signal, abort.signal]),
			}),
	};
	attached.add(entry);
	return () => {
		abort.abort();
		attached.delete(entry);
		if (attached.size === 0) presentations.delete(sessionId);
	};
}
export function getMcpGrantPresentation(sessionId: string | undefined): Select | undefined {
	return sessionId === undefined ? undefined : presentations.get(sessionId)?.values().next().value?.select;
}
export function clearMcpGrantPresentations(sessionId: string): void {
	for (const entry of presentations.get(sessionId) ?? []) entry.abort.abort();
	presentations.delete(sessionId);
}
/** Bound the decision even when an embedding's select ignores dialog options. */
export async function selectMcpGrant(
	select: Select | undefined,
	title: string,
	signal?: AbortSignal,
): Promise<boolean> {
	if (select === undefined || signal?.aborted) return false;
	const abort = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let cancel = () => {};
	const stopped = new Promise<undefined>((resolve) => {
		cancel = () => {
			abort.abort();
			resolve(undefined);
		};
		signal?.addEventListener("abort", cancel, { once: true });
		timeout = setTimeout(cancel, 120_000);
	});
	try {
		const answer = await Promise.race([
			select(title, ["Grant and save permanently", "Start without them"], {
				timeout: 120_000,
				signal: abort.signal,
			}),
			stopped,
		]);
		return answer === "Grant and save permanently" && !abort.signal.aborted;
	} catch {
		return false; // A disconnected presentation is not a grant.
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", cancel);
		abort.abort();
	}
}
