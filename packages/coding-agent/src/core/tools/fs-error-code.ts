// The fs error code a tool shows for a failed operation. A ToolMachine may pass fs errors through unchanged (the
// local machine does) or report the operation layer's own codes, as a machine reached over a wire does. The real fs
// code is used whenever the error still carries it, itself or as its `cause`. Otherwise the operation layer's
// code is mapped back only where one fs code stands behind it most often (not_found -> ENOENT, permission_denied ->
// EACCES, aborted -> ABORT_ERR); ENOTDIR or EPERM reported without a cause show as ENOENT or EACCES, and an
// `io_error` without a cause shows as io_error, because the machine did not say which errno it was.
const FS_CODE_OF_OP_CODE: Readonly<Record<string, string>> = {
	not_found: "ENOENT",
	permission_denied: "EACCES",
	aborted: "ABORT_ERR",
};

function stringCode(value: unknown): string | undefined {
	return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
		? value.code
		: undefined;
}

const isFsCode = (code: string) => /^E[A-Z0-9]+$/.test(code) || code === "ABORT_ERR";

export function fsErrorCode(error: unknown): string | undefined {
	const code = stringCode(error);
	if (code === undefined) return undefined;
	if (isFsCode(code)) return code;
	const causeCode =
		typeof error === "object" && error !== null && "cause" in error ? stringCode(error.cause) : undefined;
	if (causeCode !== undefined && isFsCode(causeCode)) return causeCode;
	return FS_CODE_OF_OP_CODE[code] ?? code;
}
