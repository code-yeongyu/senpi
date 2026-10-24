/** Opt-in final wire-prefix fingerprints. No payload text or identifiers leave this function. */
export const CACHE_PREFIX_LOG_ENV = "SENPI_DEBUG_CACHE_PREFIX";

type RecordValue = Record<string, unknown>;
type Fingerprint = { hash: string; bytes: number };

function record(value: unknown): RecordValue {
	return typeof value === "object" && value !== null ? (value as RecordValue) : {};
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

export function logAnthropicCachePrefix(
	model: { provider: string; id: string; baseUrl?: string },
	payload: unknown,
	headerSources: readonly (Readonly<Record<string, string | null | undefined>> | undefined)[] = [],
	env: Readonly<Record<string, string | undefined>> = typeof process === "undefined" ? {} : process.env,
): void {
	const flag = env[CACHE_PREFIX_LOG_ENV];
	if (!flag || flag === "0" || typeof process === "undefined") return;
	// Node builtins are resolved only at this existing browser-safe debug boundary.
	const fs = process.getBuiltinModule?.("node:fs");
	const crypto = process.getBuiltinModule?.("node:crypto");
	const path = process.getBuiltinModule?.("node:path");
	if (!fs || !crypto || !path) return;
	const fingerprint = (value: unknown): Fingerprint => {
		const text = JSON.stringify(value) ?? "null";
		return {
			hash: crypto.createHash("sha256").update(text).digest("hex"),
			bytes: new TextEncoder().encode(text).length,
		};
	};
	const body = record(payload);
	const checkpoints: (string | number)[][] = [];
	const mark = (value: unknown, position: (string | number)[]) => {
		if (record(value).cache_control !== undefined) checkpoints.push(position);
		return fingerprint(value);
	};
	let betaHeader: string | null | undefined;
	for (const headers of headerSources) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			if (name.toLowerCase() === "anthropic-beta") betaHeader = value;
		}
	}
	const betas = [
		...new Set(
			(betaHeader ?? "")
				.split(",")
				.map((beta) => beta.trim())
				.filter(Boolean),
		),
	].sort();
	const snapshot = {
		partition: fingerprint([model.provider, body.model ?? model.id, model.baseUrl, betas]),
		system: list(body.system).map((section, index) => mark(section, ["system", index])),
		tools: list(body.tools).map((tool, index) => ({
			...mark(tool, ["tools", index]),
			schema: fingerprint(record(tool).input_schema),
		})),
		messages: list(body.messages).map((message, index) => ({
			...fingerprint(message),
			blocks: list(record(message).content).map((block, blockIndex) => mark(block, ["messages", index, blockIndex])),
		})),
		checkpoints,
	};
	const dir = flag;
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.appendFileSync(path.join(dir, "cache-prefix.jsonl"), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
}
