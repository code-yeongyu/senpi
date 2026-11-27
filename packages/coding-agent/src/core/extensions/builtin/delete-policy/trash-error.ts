export const TRASH_ERROR_CODES = [
	"not_found",
	"mount_point",
	"inside_trash",
	"cross_device",
	"no_trash",
	"trash_full",
	"restore_collision",
	"refused",
	"unsupported_platform",
] as const;
export type TrashErrorCode = (typeof TRASH_ERROR_CODES)[number];

/** A refusal: the target is left exactly where it was. */
export class TrashError extends Error {
	readonly code: TrashErrorCode;

	constructor(code: TrashErrorCode, message: string) {
		super(message);
		this.name = "TrashError";
		this.code = code;
	}
}

export function errnoCode(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const code: unknown = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}
