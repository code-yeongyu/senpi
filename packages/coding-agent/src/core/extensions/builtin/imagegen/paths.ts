import { isAbsolute, relative, resolve } from "node:path";

export const GENERATED_IMAGE_DIRECTORY = "generated-images";
const DEFAULT_DIRECTORY = GENERATED_IMAGE_DIRECTORY;
const MAX_TOOL_CALL_ID_CHARS = 64;

export type TargetPaths = { ok: true; paths: string[] } | { ok: false; error: string };

/**
 * Reduces a provider-supplied identifier to a safe file stem: path separators and
 * any other unexpected character collapse to `_`, the result is length-capped, and
 * an identifier that sanitizes to nothing falls back to `image`.
 */
export function sanitizeImageStem(identifier: string): string {
	const sanitized = identifier.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_TOOL_CALL_ID_CHARS);
	return sanitized.length > 0 ? sanitized : "image";
}

function sanitizeToolCallId(toolCallId: string): string {
	return sanitizeImageStem(toolCallId);
}

/**
 * Resolves the absolute destination paths for a generation call.
 *
 * A relative output_path resolves against the working directory. An omitted path
 * falls back to generated-images/<sanitized tool call id>.png. An extensionless
 * path gains .png; any other extension is rejected. With more than one image a
 * zero-padded index is inserted before the extension.
 */
export function resolveTargets(
	cwd: string,
	toolCallId: string,
	count: number,
	outputPath: string | undefined,
): TargetPaths {
	const requested = outputPath?.trim();
	let base: string;
	if (requested === undefined || requested.length === 0) {
		base = resolve(cwd, DEFAULT_DIRECTORY, `${sanitizeToolCallId(toolCallId)}.png`);
	} else {
		const absolute = isAbsolute(requested) ? requested : resolve(cwd, requested);
		const extensionMatch = /\.[^./\\]+$/.exec(absolute);
		if (extensionMatch && extensionMatch[0].toLowerCase() !== ".png") {
			return { ok: false, error: `Error: output_path must end in .png (got "${requested}").` };
		}
		base = extensionMatch ? absolute : `${absolute}.png`;
	}
	if (count === 1) return { ok: true, paths: [base] };
	const stem = base.slice(0, -".png".length);
	return {
		ok: true,
		paths: Array.from({ length: count }, (_, index) => `${stem}-${String(index + 1).padStart(2, "0")}.png`),
	};
}

/** Prefers a path relative to the working directory, falling back to absolute. */
export function displayPath(cwd: string, absolute: string): string {
	const relativePath = relative(cwd, absolute);
	return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : absolute;
}
