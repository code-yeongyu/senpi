// The fs error code a tool shows for a failed operation. A ToolMachine may pass fs errors through unchanged (the
// local machine does) or report the operation layer's own codes, as a machine reached over a wire does; the
// tools answer with the same fs code either way.
const FS_CODE_OF_OP_CODE: Readonly<Record<string, string>> = {
	not_found: "ENOENT",
	permission_denied: "EACCES",
	aborted: "ABORT_ERR",
};

export function fsErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") {
		return undefined;
	}
	return FS_CODE_OF_OP_CODE[error.code] ?? error.code;
}
