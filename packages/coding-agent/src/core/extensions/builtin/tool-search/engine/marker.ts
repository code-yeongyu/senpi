export const TOOL_SEARCH_ACTIVATION_MARKER_V2 = "[tool_search:activated:v2]";
export const LEGACY_TOOL_SEARCH_ACTIVATION_MARKER = "[tool_search:activated]";

export interface ToolActivationIdentity {
	name: string;
	registrationId: string;
}

export type ParsedActivationMarker =
	| { version: 2; activations: ToolActivationIdentity[] }
	| { version: 1; names: string[] };

export interface RehydratableToolSearchDocument {
	name: string;
	registrationId: string;
	source: "mcp" | "extension";
	allowLazyActivation?: boolean;
}

export type RegistrationIdentityInput =
	| { source: "mcp"; server: string; name: string }
	| { source: "extension"; sourceInfo: { path: string; resolvedPath?: string }; name: string };

/**
 * Derive the host-owned registration identity for a tool. Authors must never
 * supply this value: it binds an activation marker to the canonical owner and
 * tool name selected by the current registry generation.
 */
export function deriveRegistrationId(input: RegistrationIdentityInput): string {
	if (input.source === "mcp") return `mcp\0${input.server}\0${input.name}`;
	return `${input.sourceInfo.resolvedPath ?? input.sourceInfo.path}\0${input.name}`;
}

export function deriveMcpRegistrationId(server: string, toolName: string): string {
	return deriveRegistrationId({ source: "mcp", server, name: toolName });
}

export function deriveExtensionRegistrationId(
	sourceInfo: { path: string; resolvedPath?: string },
	toolName: string,
): string {
	return deriveRegistrationId({ source: "extension", sourceInfo, name: toolName });
}

/** Emit a compact ownership-aware activation marker for persisted history. */
export function emitActivationMarker(activations: readonly ToolActivationIdentity[]): string {
	return `${TOOL_SEARCH_ACTIVATION_MARKER_V2} ${JSON.stringify(activations)}`;
}

/** Parse ownership-aware v2 markers and legacy MCP name-only markers. */
export function parseActivationMarkers(messages: readonly unknown[]): ParsedActivationMarker[] {
	const markers: ParsedActivationMarker[] = [];
	for (const message of messages) {
		let blob: string;
		try {
			blob = JSON.stringify(message) ?? "";
		} catch {
			continue;
		}

		for (const payload of extractV2Payloads(blob)) {
			const activations = parseV2Payload(payload);
			if (activations.length > 0) markers.push({ version: 2, activations });
		}
		for (const segment of extractLegacyActivationSegments(blob)) {
			const names = segment
				.trim()
				.split(/\s+/)
				.filter((name) => name.length > 0);
			if (names.length > 0) markers.push({ version: 1, names });
		}
	}
	return markers;
}

/**
 * Restore valid activation history against the current winning registry docs.
 *
 * This pure scan is intended to run ONCE per registry generation. The owning
 * service is responsible for generation-level memoization; callers must not
 * continuously reapply history after each active-tool update.
 */
export function rehydrate(
	messages: readonly unknown[],
	currentDocsByName: ReadonlyMap<string, RehydratableToolSearchDocument>,
): string[] {
	const restored = new Set<string>();
	for (const marker of parseActivationMarkers(messages)) {
		if (marker.version === 2) {
			for (const activation of marker.activations) {
				const current = currentDocsByName.get(activation.name);
				if (
					current !== undefined &&
					current.allowLazyActivation !== false &&
					current.registrationId === activation.registrationId
				) {
					restored.add(activation.name);
				}
			}
			continue;
		}

		for (const name of marker.names) {
			const current = currentDocsByName.get(name);
			if (current?.source === "mcp" && current.allowLazyActivation !== false) restored.add(name);
		}
	}
	return [...restored].sort();
}

function extractV2Payloads(blob: string): string[] {
	const payloads: string[] = [];
	let cursor = blob.indexOf(TOOL_SEARCH_ACTIVATION_MARKER_V2);
	while (cursor >= 0) {
		const encodedRemainder = extractEncodedJsonStringRemainder(
			blob,
			cursor + TOOL_SEARCH_ACTIVATION_MARKER_V2.length,
		);
		if (encodedRemainder !== undefined) {
			try {
				const decodedRemainder = JSON.parse(`"${encodedRemainder}"`) as unknown;
				if (typeof decodedRemainder === "string") {
					const payload = extractJsonArrayPrefix(decodedRemainder.trimStart());
					if (payload !== undefined) payloads.push(payload);
				}
			} catch {
				// Malformed history is ignored during best-effort rehydration.
			}
		}
		cursor = blob.indexOf(TOOL_SEARCH_ACTIVATION_MARKER_V2, cursor + TOOL_SEARCH_ACTIVATION_MARKER_V2.length);
	}
	return payloads;
}

function extractEncodedJsonStringRemainder(blob: string, start: number): string | undefined {
	let encoded = "";
	for (let index = start; index < blob.length; index++) {
		const character = blob[index];
		if (character === '"') return encoded;
		if (character === "\n") return undefined;
		if (character === "\\") {
			const escaped = blob[index + 1];
			if (escaped === undefined) return undefined;
			encoded += character + escaped;
			index++;
			continue;
		}
		encoded += character;
	}
	return undefined;
}

function extractJsonArrayPrefix(text: string): string | undefined {
	if (!text.startsWith("[")) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === "[") depth++;
		else if (character === "]") {
			depth--;
			if (depth === 0) return text.slice(0, index + 1);
			if (depth < 0) return undefined;
		}
	}
	return undefined;
}

function parseV2Payload(payload: string): ToolActivationIdentity[] {
	try {
		const parsed = JSON.parse(payload) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isToolActivationIdentity);
	} catch {
		return [];
	}
}

function isToolActivationIdentity(value: unknown): value is ToolActivationIdentity {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { name?: unknown; registrationId?: unknown };
	return (
		typeof candidate.name === "string" &&
		candidate.name.length > 0 &&
		typeof candidate.registrationId === "string" &&
		candidate.registrationId.length > 0
	);
}

/**
 * Keep this scanner byte-for-byte equivalent to the legacy MCP extraction
 * semantics so old JSON-stringified session history remains compatible.
 */
function extractLegacyActivationSegments(blob: string): string[] {
	const segments: string[] = [];
	let cursor = blob.indexOf(LEGACY_TOOL_SEARCH_ACTIVATION_MARKER);
	while (cursor >= 0) {
		const rest = blob.slice(cursor + LEGACY_TOOL_SEARCH_ACTIVATION_MARKER.length);
		// Tool names are [a-zA-Z0-9_-]; stop at the first JSON string terminator
		// (quote / escape) or newline so we never swallow the rest of the blob.
		const end = rest.search(/["\\\n]/);
		segments.push(end < 0 ? rest : rest.slice(0, end));
		cursor = blob.indexOf(LEGACY_TOOL_SEARCH_ACTIVATION_MARKER, cursor + LEGACY_TOOL_SEARCH_ACTIVATION_MARKER.length);
	}
	return segments;
}
