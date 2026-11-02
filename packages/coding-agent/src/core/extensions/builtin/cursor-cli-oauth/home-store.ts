import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertValidAccountName, type CursorCliAccountSlot } from "./accounts.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type CursorAccountHomeLogger = (line: string) => void;

export type CursorAccountHomeRunContext = {
	home: string;
	authPath: string;
};

export type CursorAccountHomeRunResult<T> = {
	result: T;
	slot: CursorCliAccountSlot;
	home: string;
};

type CursorFileCredential = {
	accessToken: string;
	refreshToken: string;
	apiKey: null;
	bedrockCredentials: null;
};

type CursorAccountPaths = CursorAccountHomeRunContext & {
	directories: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInside(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot !== "" && !isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`)
	);
}

function accountPaths(agentDir: string, accountName: string): CursorAccountPaths {
	assertValidAccountName(accountName);

	const extensionRoot = resolve(agentDir, "cursor-cli-oauth");
	const accountsRoot = resolve(extensionRoot, "accounts");
	const slotRoot = resolve(accountsRoot, accountName);
	const home = resolve(slotRoot, "home");
	if (!isInside(accountsRoot, slotRoot) || !isInside(accountsRoot, home)) {
		throw new Error(`Cursor account HOME for '${accountName}' escapes the accounts root`);
	}
	const cursorDirectory = resolve(home, ".cursor");
	if (!isInside(home, cursorDirectory)) {
		throw new Error(`Cursor credential directory for '${accountName}' escapes its HOME`);
	}

	return {
		home,
		authPath: resolve(cursorDirectory, "auth.json"),
		directories: [extensionRoot, accountsRoot, slotRoot, home, cursorDirectory],
	};
}

function ensurePrivateDirectories(directories: readonly string[]): void {
	for (const directory of directories) {
		mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		chmodSync(directory, PRIVATE_DIRECTORY_MODE);
	}
}

function serializeCredential(slot: CursorCliAccountSlot): string {
	const credential: CursorFileCredential = {
		accessToken: slot.access,
		refreshToken: slot.refresh,
		apiKey: null,
		bedrockCredentials: null,
	};
	return JSON.stringify(credential);
}

function parseCredential(contents: string): CursorFileCredential {
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		throw new Error("Invalid Cursor credential: auth.json is not valid JSON");
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.accessToken !== "string" ||
		parsed.accessToken.length === 0 ||
		typeof parsed.refreshToken !== "string" ||
		parsed.refreshToken.length === 0 ||
		parsed.apiKey !== null ||
		parsed.bedrockCredentials !== null
	) {
		throw new Error("Invalid Cursor credential: auth.json does not match the file-store contract");
	}
	return {
		accessToken: parsed.accessToken,
		refreshToken: parsed.refreshToken,
		apiKey: null,
		bedrockCredentials: null,
	};
}

function prepareAccountHome(
	paths: CursorAccountPaths,
	slot: CursorCliAccountSlot,
	log?: CursorAccountHomeLogger,
): void {
	ensurePrivateDirectories(paths.directories);
	writeFileSync(paths.authPath, serializeCredential(slot), {
		encoding: "utf8",
		mode: PRIVATE_FILE_MODE,
	});
	chmodSync(paths.authPath, PRIVATE_FILE_MODE);
	log?.(
		`cursor_cli_oauth_credential_written accessBytes=${Buffer.byteLength(slot.access, "utf8")} refreshBytes=${Buffer.byteLength(slot.refresh, "utf8")}`,
	);
}

function readBackSlot(
	paths: CursorAccountPaths,
	slot: CursorCliAccountSlot,
	log?: CursorAccountHomeLogger,
): CursorCliAccountSlot {
	const credential = parseCredential(readFileSync(paths.authPath, "utf8"));
	log?.(
		`cursor_cli_oauth_credential_read accessBytes=${Buffer.byteLength(credential.accessToken, "utf8")} refreshBytes=${Buffer.byteLength(credential.refreshToken, "utf8")} rotated=${credential.refreshToken !== slot.refresh}`,
	);
	return credential.refreshToken === slot.refresh ? slot : { ...slot, refresh: credential.refreshToken };
}

/**
 * Runs one Cursor CLI invocation inside a durable per-account HOME.
 *
 * The credential is deliberately rewritten immediately before `run` because
 * cursor-agent may modify other files under `.cursor` during an invocation.
 * Nothing in the HOME is removed after the run, preserving CLI chat history.
 */
export async function runInCursorAccountHome<T>(
	agentDir: string,
	slot: CursorCliAccountSlot,
	run: (context: CursorAccountHomeRunContext) => Promise<T>,
	log?: CursorAccountHomeLogger,
): Promise<CursorAccountHomeRunResult<T>> {
	const paths = accountPaths(agentDir, slot.name);
	prepareAccountHome(paths, slot, log);
	const result = await run({ home: paths.home, authPath: paths.authPath });
	const updatedSlot = readBackSlot(paths, slot, log);
	return { result, slot: updatedSlot, home: paths.home };
}
