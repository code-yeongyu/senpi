/** Where a local transport listens: an owner-only Unix socket on POSIX, a named pipe (no file, no mode) on Windows. */
export type LocalEndpoint =
	| { readonly kind: "unix-socket"; readonly address: string; readonly mode: number }
	| { readonly kind: "named-pipe"; readonly address: string };

const PIPE_PREFIX = "\\\\.\\pipe\\";
const PIPE_MAX_LENGTH = 256;
const OWNER_ONLY = 0o600;

export function localEndpoint(platform: string, name: string, socketDir: string): LocalEndpoint {
	if (name.length === 0 || /[\\/]/.test(name)) {
		throw new RangeError(
			`local endpoint: a name must be non-empty with no path separator, got ${JSON.stringify(name)}`,
		);
	}
	if (platform === "win32") {
		const address = `${PIPE_PREFIX}${name}`;
		if (address.length > PIPE_MAX_LENGTH)
			throw new RangeError(`local endpoint: a pipe name is at most ${PIPE_MAX_LENGTH} characters`);
		return { kind: "named-pipe", address };
	}
	return { kind: "unix-socket", address: `${socketDir.replace(/\/+$/, "")}/${name}.sock`, mode: OWNER_ONLY };
}

/** The identity of an endpoint: Windows pipe names compare case-insensitively, socket paths exactly. */
export function endpointKey(endpoint: LocalEndpoint): string {
	return endpoint.kind === "named-pipe" ? endpoint.address.toUpperCase() : endpoint.address;
}
