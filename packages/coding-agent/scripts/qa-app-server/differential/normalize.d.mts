export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type TranscriptDirection = "client->server" | "server->client";

export type TranscriptRecord = {
	readonly seq: number;
	readonly direction: TranscriptDirection;
	readonly target: string;
	readonly frame: JsonValue;
};

export type NormalizeOptions = {
	readonly tempPaths?: readonly string[];
	readonly tokens?: readonly string[];
};

export function normalizeTranscript(
	records: readonly TranscriptRecord[],
	options?: NormalizeOptions,
): TranscriptRecord[];
