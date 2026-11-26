import { currentShareRedactionContext, redactShareText, type ShareRedactionTally } from "./share-redaction.ts";

export interface UploadRedactionOptions {
	/** Extra identity values to remove, e.g. a remote engine host's account and host names. */
	readonly extraLiterals?: readonly string[];
}

export interface UploadRedaction {
	readonly text: string;
	readonly counts: Readonly<Record<string, number>>;
}

/**
 * The redaction for any text an extension sends off this machine (#3674). It is the `/share` redactor itself
 * (`redactShareText`, #3524) with this machine's identity, so there is exactly one set of rules.
 */
export function redactForUpload(text: string, options: UploadRedactionOptions = {}): UploadRedaction {
	const tally: ShareRedactionTally = new Map();
	const context = currentShareRedactionContext();
	const extra = (options.extraLiterals ?? []).filter((value) => value.trim().length > 0);
	const redacted = redactShareText(text, extra.length === 0 ? context : { ...context, extraLiterals: extra }, tally);
	return { text: redacted, counts: Object.fromEntries(tally) };
}
