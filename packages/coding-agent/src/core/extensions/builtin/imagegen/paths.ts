import { isAbsolute, relative, resolve } from "node:path";

export const GENERATED_IMAGE_DIRECTORY = "generated-images";
const DEFAULT_DIRECTORY = GENERATED_IMAGE_DIRECTORY;
const MAX_TOOL_CALL_ID_CHARS = 64;

export type OutputFormat = "png" | "jpeg" | "webp";
const EXTENSIONS: Record<OutputFormat, readonly string[]> = {
	png: [".png"],
	jpeg: [".jpg", ".jpeg"],
	webp: [".webp"],
};

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
 * falls back to generated-images/<sanitized tool call id> with the format's
 * extension. An extensionless path gains that extension; an extension that does
 * not belong to the format is rejected (.jpg and .jpeg both serve jpeg). With more
 * than one image a zero-padded index is inserted before the extension.
 */
export function resolveTargets(
	cwd: string,
	toolCallId: string,
	count: number,
	outputPath: string | undefined,
	outputFormat: OutputFormat = "png",
): TargetPaths {
	const allowed = EXTENSIONS[outputFormat];
	const defaultExtension = allowed[0] ?? ".png";
	const requested = outputPath?.trim();
	let base: string;
	let extension: string;
	if (requested === undefined || requested.length === 0) {
		base = resolve(cwd, DEFAULT_DIRECTORY, `${sanitizeToolCallId(toolCallId)}${defaultExtension}`);
		extension = defaultExtension;
	} else {
		const absolute = isAbsolute(requested) ? requested : resolve(cwd, requested);
		const extensionMatch = /\.[^./\\]+$/.exec(absolute);
		if (extensionMatch && !allowed.includes(extensionMatch[0].toLowerCase())) {
			return {
				ok: false,
				error: `Error: output_path must end in ${allowed.join(" or ")} for output_format ${outputFormat} (got "${requested}").`,
			};
		}
		extension = extensionMatch ? extensionMatch[0] : defaultExtension;
		base = extensionMatch ? absolute : `${absolute}${defaultExtension}`;
	}
	if (count === 1) return { ok: true, paths: [base] };
	const stem = base.slice(0, -extension.length);
	return {
		ok: true,
		paths: Array.from({ length: count }, (_, index) => `${stem}-${String(index + 1).padStart(2, "0")}${extension}`),
	};
}

/** The output format a returned MIME type denotes, or undefined for anything outside the supported three. */
export function outputFormatOf(mimeType: string): OutputFormat | undefined {
	if (mimeType === "image/png") return "png";
	if (mimeType === "image/jpeg") return "jpeg";
	if (mimeType === "image/webp") return "webp";
	return undefined;
}

/** Swaps a target's extension so the file name matches the bytes a provider actually returned. */
export function withFormatExtension(path: string, outputFormat: OutputFormat): string {
	const extension = EXTENSIONS[outputFormat][0] ?? ".png";
	const extensionMatch = /\.[^./\\]+$/.exec(path);
	const current = extensionMatch?.[0].toLowerCase();
	if (current !== undefined && EXTENSIONS[outputFormat].includes(current)) return path;
	return extensionMatch ? `${path.slice(0, -extensionMatch[0].length)}${extension}` : `${path}${extension}`;
}

/** Prefers a path relative to the working directory, falling back to absolute. */
export function displayPath(cwd: string, absolute: string): string {
	const relativePath = relative(cwd, absolute);
	return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : absolute;
}
