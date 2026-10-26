/** What a full disk refused: the session file and the bytes the failed write needed. */
export interface DiskFullDetails {
	readonly path: string;
	readonly neededBytes: number;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * A session write the filesystem refused because it is full (`ENOSPC`) or the user's quota is spent (`EDQUOT`).
 * Keeps the system `code` so callers that match it still do, and adds `errorCause: "disk_full"` with an actionable
 * message that names the file and the space the write needed (senpi#4295). The free space is not probed here: the
 * write path is synchronous and the session path admits no new blocking filesystem calls.
 */
export class SessionDiskFullError extends Error implements DiskFullDetails {
	readonly errorCause = "disk_full";
	readonly code: "ENOSPC" | "EDQUOT";
	readonly path: string;
	readonly neededBytes: number;

	constructor(code: "ENOSPC" | "EDQUOT", details: DiskFullDetails, cause: unknown) {
		const what = code === "EDQUOT" ? "the disk quota for this user is used up" : "the disk is full";
		super(
			`Disk full: the session could not be saved because ${what} (${details.path} needed ${formatBytes(details.neededBytes)}). Free disk space, then continue this session.`,
			{ cause },
		);
		this.name = "SessionDiskFullError";
		this.code = code;
		this.path = details.path;
		this.neededBytes = details.neededBytes;
	}

	get details(): DiskFullDetails {
		return { path: this.path, neededBytes: this.neededBytes };
	}
}

/** `error` as a {@link SessionDiskFullError} when a full disk caused it, else `error` unchanged. */
export function sessionWriteError(error: unknown, path: string, neededBytes: number): unknown {
	if (error instanceof SessionDiskFullError) return error;
	const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code !== "ENOSPC" && code !== "EDQUOT") return error;
	return new SessionDiskFullError(code, { path, neededBytes }, error);
}
