/**
 * A session's own persona (`open_session.persona`): the instructions appended to its system prompt and the tool
 * policy it runs under, as `--append-system-prompt`, `--tools` / `--no-tools` and `--exclude-tools` give one to a
 * process. It only ever narrows what the host's own flags allow, and it is held on the session's launch profile, so
 * it follows the session through a worker, a session replace and a successor generation's reopen.
 */
export interface SessionPersona {
	/** Literal text appended to the system prompt; never read as a file path. */
	readonly appendSystemPrompt?: string;
	/** The only tools the session may have; an empty list means none. */
	readonly tools?: readonly string[];
	/** Tools the session never has, whatever else allows them. */
	readonly excludeTools?: readonly string[];
}

/** The bytes one argv entry holds on POSIX with headroom: what a per-process child could have been given. */
const MAX_SESSION_PERSONA_PROMPT_BYTES = 100_000;
const MAX_SESSION_PERSONA_TOOLS = 256;
const MAX_TOOL_NAME_LENGTH = 128;

/**
 * Detail for an `open_session.persona` the host refuses, or undefined when it is absent or well formed. A malformed
 * persona is refused rather than ignored, so a caller that asked for a tool policy never runs without one unknowingly.
 */
export function sessionPersonaError(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const shape = "persona must be { appendSystemPrompt?: string, tools?: string[], excludeTools?: string[] }.";
	if (typeof value !== "object" || value === null || Array.isArray(value)) return shape;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => key !== "appendSystemPrompt" && key !== "tools" && key !== "excludeTools"))
		return shape;
	const prompt = record.appendSystemPrompt;
	if (prompt !== undefined) {
		if (typeof prompt !== "string" || prompt.length === 0) return shape;
		if (Buffer.byteLength(prompt, "utf8") > MAX_SESSION_PERSONA_PROMPT_BYTES)
			return `persona.appendSystemPrompt allows at most ${MAX_SESSION_PERSONA_PROMPT_BYTES} UTF-8 bytes.`;
	}
	for (const key of ["tools", "excludeTools"] as const) {
		const names = record[key];
		if (names === undefined) continue;
		if (!Array.isArray(names) || !names.every(isToolName)) return shape;
		if (names.length > MAX_SESSION_PERSONA_TOOLS)
			return `persona.${key} allows at most ${MAX_SESSION_PERSONA_TOOLS} tool names.`;
	}
	return undefined;
}

// A padded name would match no tool, so a deny entry like " write" would deny nothing: refused, never trimmed.
function isToolName(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.trim() === value && value.length <= MAX_TOOL_NAME_LENGTH
	);
}

/**
 * A persona allowlist on a host that restricts its built-in tools by default (`--no-builtin-tools`, settings `defaultTools`)
 * without a `--tools` of its own: those defaults apply at registration, which the narrowing does not see, so naming a tool
 * there could enable a built-in the host keeps off. Refused instead of widened (omo#13057 review L2).
 */
export function personaToolsUnsupported(
	persona: SessionPersona | undefined,
	host: { readonly tools?: readonly string[]; readonly noBuiltinTools?: boolean; readonly defaultTools?: unknown },
): boolean {
	return (
		persona?.tools !== undefined &&
		host.tools === undefined &&
		(host.noBuiltinTools === true || host.defaultTools !== undefined)
	);
}

/** The tool flags a runtime is built from (`Args` fields). */
export interface PersonaToolFlags {
	readonly tools?: string[];
	readonly noTools?: boolean;
	readonly excludeTools?: string[];
}

/**
 * The host's tool flags narrowed by a session's persona: the allowlist is the intersection of both (an empty one
 * means no tools), the denylist is their union. Nothing the host's own flags exclude is ever allowed back.
 */
export function withSessionPersona<F extends PersonaToolFlags>(flags: F, persona: SessionPersona | undefined): F {
	if (persona === undefined) return flags;
	const allow = persona.tools;
	const tools =
		allow === undefined ? flags.tools : (flags.tools?.filter((name) => allow.includes(name)) ?? [...allow]);
	const excludeTools =
		persona.excludeTools === undefined
			? flags.excludeTools
			: [...new Set([...(flags.excludeTools ?? []), ...persona.excludeTools])];
	const noTools = flags.noTools === true || tools?.length === 0;
	const { tools: _tools, noTools: _noTools, excludeTools: _excludeTools, ...rest } = flags;
	return {
		...rest,
		...(noTools ? { noTools: true } : tools === undefined ? {} : { tools }),
		...(excludeTools === undefined ? {} : { excludeTools }),
	} as F;
}

/**
 * An attach that names a persona joins only a session opened with that same persona: re-joining a session that runs
 * under another (or none) would hand the caller a tool surface it did not ask for. An attach naming none keeps the
 * session's own. Returns the refusal detail, or undefined when the attach may proceed.
 */
export function attachPersonaMismatch(
	requested: SessionPersona | undefined,
	held: SessionPersona | undefined,
): Readonly<Record<string, unknown>> | undefined {
	if (requested === undefined || samePersona(requested, held)) return undefined;
	return { reason: "persona_mismatch", action: "open_a_new_session" };
}

/** A copy no caller's array can change afterwards. */
export function frozenPersona(persona: SessionPersona): SessionPersona {
	return Object.freeze({
		...(persona.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: persona.appendSystemPrompt }),
		...(persona.tools === undefined ? {} : { tools: Object.freeze([...persona.tools]) }),
		...(persona.excludeTools === undefined ? {} : { excludeTools: Object.freeze([...persona.excludeTools]) }),
	});
}

/** Whether two opens name the same persona; a session's persona never changes once it is open. */
function samePersona(a: SessionPersona | undefined, b: SessionPersona | undefined): boolean {
	return (
		a?.appendSystemPrompt === b?.appendSystemPrompt &&
		sameNames(a?.tools, b?.tools) &&
		sameNames(a?.excludeTools, b?.excludeTools)
	);
}

function sameNames(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	const left = [...new Set(a)].sort();
	const right = [...new Set(b)].sort();
	return left.length === right.length && left.every((name, index) => name === right[index]);
}
