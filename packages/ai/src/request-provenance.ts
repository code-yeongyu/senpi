import type { ProviderRequestProvenance, StreamOptions } from "./types.ts";

/** One request-local factory shared by runtime and provider-owned credential attempts. */
export function createRequestAttemptProvenance(): NonNullable<StreamOptions["createRequestProvenance"]> {
	const requestId = globalThis.crypto.randomUUID();
	let previous: { readonly lane: "stored" | "env"; readonly name: string } | undefined;
	let failoverIndex = 0;
	return (slot) => {
		if (slot) {
			if (previous && (previous.lane !== slot.lane || previous.name !== slot.name)) failoverIndex++;
			previous = { lane: slot.lane, name: slot.name };
		}
		const safeName =
			slot &&
			/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/.test(slot.name) &&
			!/^(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)/i.test(slot.name)
				? slot.name
				: undefined;
		return Object.freeze({
			requestId,
			attemptId: globalThis.crypto.randomUUID(),
			failoverIndex,
			...(slot
				? { slot: Object.freeze({ lane: slot.lane, ...(safeName === undefined ? {} : { name: safeName }) }) }
				: {}),
		}) satisfies ProviderRequestProvenance;
	};
}
