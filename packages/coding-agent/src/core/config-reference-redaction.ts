/**
 * Resolved-value registry shared by every copy of this module in one JavaScript realm (omo#12965).
 *
 * A process can evaluate this module more than once (the bundle's shared chunk, its self-contained session-worker
 * entry, and the SDK graph an in-process child loads), so the values are not kept in a module-local set: the first
 * copy pins a frozen registry on `globalThis` under `SLOT_KEY` (non-writable, non-configurable, non-enumerable) and
 * every later copy adopts it. The backing `Set` lives only in the installing copy's closure; the registry offers no
 * delete, clear or setter, so in-realm code cannot remove a value, replace the slot or turn redaction off. Any
 * in-realm code can `add` a string, which can only over-redact. This is a stopgap until one engine instance serves
 * the whole process; other realms (workers, `vm` contexts, child processes) keep their own registry.
 *
 * Compatibility contract, permanent: the key string never changes. The v1 members `version` (1), `add(value)`,
 * `size` (an accessor reporting the live count) and `values()` (a fresh array) are never removed or repurposed; a
 * later contract keeps writing through this same slot and only adds members, and adopters ignore members they do not
 * know. A copy adopts only a slot pinned the way `pin` pins it, frozen, with those four members; anything else (a
 * slot planted before the first copy loaded, an accessor, another version) makes the import throw
 * `ConfigReferenceRedactionSlotError`, because a copy running with a private set is the leak this registry removes.
 */
const SLOT_KEY_NAME = "@code-yeongyu/senpi/config-reference-redaction/v1";
const SLOT_KEY = Symbol.for(SLOT_KEY_NAME);
const MIN_REDACTED_LENGTH = 4;
/** The largest `$file` reference value (`config-reference-file.ts`); longer strings are never remembered. */
const MAX_REMEMBERED_LENGTH = 65_536;

interface ResolvedValueRegistry {
	readonly version: 1;
	add(value: unknown): void;
	readonly size: number;
	values(): string[];
}

class ConfigReferenceRedactionSlotError extends Error {
	readonly code: "SENPI_REDACTION_SLOT_INCOMPATIBLE";
	constructor(cause?: unknown) {
		super(
			`The process-wide redaction registry ${SLOT_KEY_NAME} was not installed by senpi or is incompatible; restart the process.`,
			cause === undefined ? undefined : { cause },
		);
		this.name = "ConfigReferenceRedactionSlotError";
		this.code = "SENPI_REDACTION_SLOT_INCOMPATIBLE";
	}
}

function createRegistry(): ResolvedValueRegistry {
	const values = new Set<string>();
	return Object.freeze({
		version: 1 as const,
		add(value: unknown) {
			if (typeof value !== "string" || value.length < MIN_REDACTED_LENGTH || value.length > MAX_REMEMBERED_LENGTH)
				return;
			values.add(value);
		},
		get size() {
			return values.size;
		},
		values: () => [...values],
	});
}

function isFrozenV1Registry(value: unknown): value is ResolvedValueRegistry {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.isFrozen(value) &&
		Reflect.get(value, "version") === 1 &&
		typeof Reflect.get(value, "add") === "function" &&
		typeof Reflect.get(value, "values") === "function" &&
		typeof Reflect.get(value, "size") === "number"
	);
}

function pin(registry: ResolvedValueRegistry): ResolvedValueRegistry {
	try {
		Object.defineProperty(globalThis, SLOT_KEY, {
			value: registry,
			writable: false,
			configurable: false,
			enumerable: false,
		});
	} catch (error) {
		throw new ConfigReferenceRedactionSlotError(error);
	}
	return registry;
}

function sharedRegistry(): ResolvedValueRegistry {
	const slot = Reflect.getOwnPropertyDescriptor(globalThis, SLOT_KEY);
	if (slot === undefined) return pin(createRegistry());
	const value: unknown = slot.value;
	if (slot.writable !== false || slot.configurable !== false || !isFrozenV1Registry(value)) {
		throw new ConfigReferenceRedactionSlotError();
	}
	return value;
}

const registry = sharedRegistry();
let redactionForms: readonly string[] = [];
let formsSize = 0;

/** Every value a reference resolves to is kept for the process lifetime, including rotated ones: no cap, no eviction. */
export function rememberResolvedReferenceValue(value: string): void {
	registry.add(value);
}

function encodings(value: string): string[] {
	const form = new URLSearchParams([["", value]]).toString().slice(1);
	return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), encodeURI(value), form];
}

/** The registry is append-only, so a changed size is the only way its content can change. */
function forms(): readonly string[] {
	const size = registry.size;
	if (size !== formsSize) {
		redactionForms = [...new Set(registry.values().flatMap(encodings))]
			.filter((form) => form.length >= MIN_REDACTED_LENGTH)
			.sort((left, right) => right.length - left.length);
		formsSize = size;
	}
	return redactionForms;
}

/** Replaces every resolved reference value, raw or encoded, before text reaches a sink outside the process. */
export function redactResolvedReferenceValues(text: string, replacement = "<redacted>"): string {
	let redacted = text;
	for (const form of forms()) {
		if (redacted.includes(form)) redacted = redacted.split(form).join(replacement);
	}
	return redacted;
}

/** MCP content-block and resource kinds plus JSON Schema types. */
const PROTOCOL_TYPES = new Set([
	"text",
	"image",
	"audio",
	"resource",
	"resource_link",
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);
/** JSON Schema string formats. */
const SCHEMA_FORMATS = new Set([
	"date-time",
	"date",
	"time",
	"duration",
	"email",
	"idn-email",
	"hostname",
	"idn-hostname",
	"ipv4",
	"ipv6",
	"uri",
	"uri-reference",
	"iri",
	"iri-reference",
	"uri-template",
	"uuid",
	"json-pointer",
	"relative-json-pointer",
	"regex",
	"byte",
	"binary",
	"password",
]);

/** Media types MCP servers send in content blocks and resources. */
const MEDIA_TYPES = new Set([
	"text/plain",
	"text/markdown",
	"text/html",
	"text/css",
	"text/csv",
	"text/javascript",
	"text/xml",
	"text/x-python",
	"text/x-typescript",
	"application/json",
	"application/xml",
	"application/yaml",
	"application/javascript",
	"application/typescript",
	"application/pdf",
	"application/zip",
	"application/gzip",
	"application/octet-stream",
	"application/x-ndjson",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"image/bmp",
	"image/avif",
	"image/heic",
	"image/tiff",
	"audio/wav",
	"audio/mpeg",
	"audio/mp3",
	"audio/ogg",
	"audio/webm",
	"audio/flac",
	"audio/aac",
	"video/mp4",
	"video/webm",
]);
/** The published JSON Schema draft identifiers. */
const SCHEMA_URLS = new Set([
	"http://json-schema.org/draft-04/schema#",
	"http://json-schema.org/draft-06/schema#",
	"http://json-schema.org/draft-07/schema#",
	"http://json-schema.org/schema#",
	"https://json-schema.org/draft/2019-09/schema",
	"https://json-schema.org/draft/2020-12/schema",
]);

/**
 * Each protocol key keeps a value only when it EXACTLY equals an entry of its allowlist (no open patterns, so
 * no secret can hide inside a kept value); any other value is redacted as usual, so a credential echoed into a
 * protocol field is still caught (fail closed). An allowlisted value is a public protocol token, so it is kept
 * even when a remembered value happens to equal it.
 */
const PROTOCOL_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
	type: PROTOCOL_TYPES,
	mimeType: MEDIA_TYPES,
	format: SCHEMA_FORMATS,
	jsonrpc: new Set(["2.0"]),
	role: new Set(["user", "assistant"]),
	$schema: SCHEMA_URLS,
};

function isProtocolValue(key: string, value: string): boolean {
	return Object.hasOwn(PROTOCOL_VALUES, key) && PROTOCOL_VALUES[key]?.has(value) === true;
}

/** Copies JSON-shaped data, redacting string leaves only; never mutates the wire-facing original. */
export function redactResolvedReferenceData<T>(value: T): T;
export function redactResolvedReferenceData(value: unknown): unknown {
	if (registry.size === 0) return value;
	const copies = new WeakMap<object, object>();
	const pending: { source: object; target: object }[] = [];
	const copy = (input: unknown): unknown => {
		// Serialize like JSON would, so a Date reaches the sink as its ISO string rather than an empty object.
		const source =
			typeof input === "object" && input !== null && typeof Reflect.get(input, "toJSON") === "function"
				? (Reflect.get(input, "toJSON") as () => unknown).call(input)
				: input;
		if (typeof source === "string") return redactResolvedReferenceValues(source);
		if (typeof source !== "object" || source === null) return source;
		const existing = copies.get(source);
		if (existing !== undefined) return existing;
		const target: object = Array.isArray(source) ? new Array(source.length) : {};
		copies.set(source, target);
		pending.push({ source, target });
		return target;
	};
	const result = copy(value);
	// A worklist and memoized copies handle arbitrary depth, cycles and shared children.
	for (const { source, target } of pending) {
		for (const key of Object.keys(source)) {
			const child = Reflect.get(source, key);
			Object.defineProperty(target, key, {
				value: typeof child === "string" && isProtocolValue(key, child) ? child : copy(child),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return result;
}
