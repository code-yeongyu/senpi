import { type Static, Type } from "typebox";

export const LOOK_AT_USAGE = `Usage:
- look_at(file_path="/path/to/file", goal="what to extract")
- look_at(file_paths=["/path/to/file-1", "/path/to/file-2"], goal="what to extract")
- look_at(image_data="base64_encoded_data", goal="what to extract")`;

export const LOOK_AT_PARAMETERS = Type.Object({
	file_path: Type.Optional(Type.String({ description: "A local media file path or attachment reference." })),
	file_paths: Type.Optional(
		Type.Array(Type.String({ description: "A local media file path or attachment reference." })),
	),
	image_data: Type.Optional(Type.String({ description: "Base64-encoded media data." })),
	image_data_list: Type.Optional(Type.Array(Type.String({ description: "Base64-encoded media data." }))),
	goal: Type.String({ description: "The specific information to extract from the supplied media." }),
});

export type LookAtArgs = Static<typeof LOOK_AT_PARAMETERS>;

export interface LookAtArgsWithAlias extends Omit<LookAtArgs, "goal"> {
	goal?: string;
	path?: string;
}

export interface NormalizedLookAtArgs extends LookAtArgs {
	_normalized_file_paths_from_singular?: boolean;
	_normalized_image_data_list_from_singular?: boolean;
}

function hasNonEmptyString(value: string | undefined): value is string {
	return typeof value === "string" && value.length > 0;
}

function hasValues(values: string[] | undefined): values is string[] {
	return Array.isArray(values) && values.length > 0;
}

function isRemoteUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

/** Normalizes singular inputs and the legacy `path` alias before validation. */
export function normalizeLookAtArgs(args: LookAtArgsWithAlias): NormalizedLookAtArgs {
	const filePath = args.file_path ?? args.path;
	const imageData = args.image_data;
	const filePathsFromSingular = !args.file_paths && hasNonEmptyString(filePath);
	const imageDataListFromSingular = !args.image_data_list && hasNonEmptyString(imageData);

	return {
		file_path: filePath,
		file_paths: args.file_paths ?? (filePathsFromSingular ? [filePath] : undefined),
		image_data: imageData,
		image_data_list: args.image_data_list ?? (imageDataListFromSingular ? [imageData] : undefined),
		goal: args.goal ?? "",
		_normalized_file_paths_from_singular: filePathsFromSingular || undefined,
		_normalized_image_data_list_from_singular: imageDataListFromSingular || undefined,
	};
}

/**
 * Converts raw tool-call arguments into the public schema while retaining the
 * original normalizer's singular/plural semantics for validation.
 */
export function prepareLookAtArguments(args: unknown): LookAtArgs {
	const normalized = normalizeLookAtArgs(asLookAtArgsWithAlias(args));
	const prepared: LookAtArgs = { goal: normalized.goal };

	if (normalized._normalized_file_paths_from_singular) {
		if (normalized.file_paths !== undefined) prepared.file_paths = normalized.file_paths;
	} else {
		if (normalized.file_path !== undefined) prepared.file_path = normalized.file_path;
		if (normalized.file_paths !== undefined) prepared.file_paths = normalized.file_paths;
	}
	if (normalized._normalized_image_data_list_from_singular) {
		if (normalized.image_data_list !== undefined) prepared.image_data_list = normalized.image_data_list;
	} else {
		if (normalized.image_data !== undefined) prepared.image_data = normalized.image_data;
		if (normalized.image_data_list !== undefined) prepared.image_data_list = normalized.image_data_list;
	}
	return prepared;
}

export function validateLookAtArgs(args: NormalizedLookAtArgs): string | null {
	const filePath = args.file_path;
	const hasFilePath = hasNonEmptyString(filePath);
	const hasFilePaths = hasValues(args.file_paths);
	const hasImageData = hasNonEmptyString(args.image_data);
	const hasImageDataList = hasValues(args.image_data_list);

	if (hasFilePath && hasFilePaths && !args._normalized_file_paths_from_singular) {
		return "Error: Provide either 'file_path' or 'file_paths', not both.";
	}
	if (hasImageData && hasImageDataList && !args._normalized_image_data_list_from_singular) {
		return "Error: Provide either 'image_data' or 'image_data_list', not both.";
	}
	if (hasValues(args.file_paths)) {
		for (const filePath of args.file_paths) {
			if (!hasNonEmptyString(filePath)) return "Error: 'file_paths' must contain only non-empty local file paths.";
			if (isRemoteUrl(filePath)) {
				return "Error: Remote URLs are not supported for file_paths. Download the file first or use a local path.";
			}
		}
	}
	if (hasValues(args.image_data_list)) {
		for (const imageData of args.image_data_list) {
			if (!hasNonEmptyString(imageData)) {
				return "Error: 'image_data_list' must contain only non-empty Base64 image strings.";
			}
		}
	}
	if (hasFilePath && isRemoteUrl(filePath)) {
		return "Error: Remote URLs are not supported for file_path. Download the file first or use a local path.";
	}
	if (!hasFilePath && !hasFilePaths && !hasImageData && !hasImageDataList) {
		return `Error: Must provide at least one of 'file_path', 'file_paths', 'image_data', or 'image_data_list'. ${LOOK_AT_USAGE}`;
	}
	if (!args.goal) {
		return `Error: Missing required parameter 'goal'. ${LOOK_AT_USAGE}`;
	}
	return null;
}

function asLookAtArgsWithAlias(args: unknown): LookAtArgsWithAlias {
	return typeof args === "object" && args !== null ? (args as LookAtArgsWithAlias) : {};
}
