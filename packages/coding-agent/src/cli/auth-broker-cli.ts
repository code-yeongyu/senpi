import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { getAgentDir, VERSION } from "../config.ts";
import { AuthBrokerService, SqliteCredentialVault } from "../core/auth-broker.ts";
import { AUTH_BROKER_CAPABILITIES } from "../core/auth-broker-wire-contract.ts";
import type { CredentialMaterial, CredentialRecord } from "../core/auth-multi-account.ts";
import { AuthBrokerServerError, parseAuthBrokerBind, startAuthBrokerServer } from "./auth-broker-server.ts";

const TOKEN_FILE = "auth-broker.token";
const VAULT_FILE = "auth-broker.sqlite";
const ALL_CAPABILITIES = Object.values(AUTH_BROKER_CAPABILITIES);
const AUTH_BROKER_USAGE = `Usage: senpi auth-broker <command>

Commands:
  serve [--bind=127.0.0.1:8765]       Start the loopback-only broker.
  token [--regenerate] [--json]       Create or rotate the local bearer token.
  status [--json]                     Show redacted local broker status.
  login <provider> [--identity=<id>]  Store an OAuth credential in the vault.
  logout <provider> [--dry-run]       Remove provider credentials from the vault.
  import <file|dir> [--dry-run]       Import supported CLIProxyAPI OAuth records.
  migrate --from-local --dry-run --backup-receipt=<path>
                                     Create a receipt before a destructive migration.

GET /healthz is unauthenticated. POST /v1/broker requires this command's Bearer token.
External binds are rejected.
`;

type BrokerAction = "serve" | "token" | "status" | "login" | "logout" | "import" | "migrate";

type ParsedCommand = {
	readonly action: BrokerAction;
	readonly bind?: string;
	readonly dryRun: boolean;
	readonly includeDisabled: boolean;
	readonly json: boolean;
	readonly provider?: string;
	readonly receiptPath?: string;
	readonly regenerate: boolean;
	readonly source?: string;
	readonly identity?: string;
};

export type AuthBrokerCommandExecution = {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
};

export type AuthBrokerCommandOptions = {
	readonly agentDir?: string;
};

export async function handleAuthBrokerCommand(args: readonly string[]): Promise<boolean> {
	const result = await executeAuthBrokerCommand(args);
	if (result === undefined) return false;
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exitCode = result.exitCode;
	return true;
}

export async function executeAuthBrokerCommand(
	args: readonly string[],
	options: AuthBrokerCommandOptions = {},
): Promise<AuthBrokerCommandExecution | undefined> {
	if (args[0] !== "auth-broker") return undefined;
	if (args[1] === undefined || args[1] === "--help" || args[1] === "-h")
		return { exitCode: 0, stderr: "", stdout: AUTH_BROKER_USAGE };
	try {
		const command = parseCommand(args.slice(1));
		return await execute(command, agentDirectory(options));
	} catch (error) {
		const usageError = error instanceof AuthBrokerCommandError || error instanceof AuthBrokerServerError;
		const message = usageError ? error.message : "Auth broker command failed";
		return { exitCode: usageError ? 2 : 1, stderr: `Error: ${message}\n`, stdout: "" };
	}
}

class AuthBrokerCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthBrokerCommandError";
	}
}

function parseCommand(args: readonly string[]): ParsedCommand {
	const action = args[0];
	if (!isAction(action)) throw new AuthBrokerCommandError(AUTH_BROKER_USAGE.trim());
	let bind: string | undefined;
	let dryRun = false;
	let includeDisabled = false;
	let json = false;
	let provider: string | undefined;
	let receiptPath: string | undefined;
	let regenerate = false;
	let source: string | undefined;
	let identity: string | undefined;
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--dry-run") dryRun = true;
		else if (argument === "--include-disabled" && action === "import") includeDisabled = true;
		else if (argument === "--json") json = true;
		else if (argument === "--regenerate" && action === "token") regenerate = true;
		else if (argument === "--from-local" && action === "migrate") continue;
		else if (argument.startsWith("--bind=")) bind = argument.slice("--bind=".length);
		else if (argument === "--bind") bind = requiredValue(args, ++index, "--bind");
		else if (argument.startsWith("--provider=")) provider = argument.slice("--provider=".length);
		else if (argument === "--provider") provider = requiredValue(args, ++index, "--provider");
		else if (argument.startsWith("--identity=")) identity = argument.slice("--identity=".length);
		else if (argument === "--identity") identity = requiredValue(args, ++index, "--identity");
		else if (argument.startsWith("--backup-receipt=")) receiptPath = argument.slice("--backup-receipt=".length);
		else if (argument === "--backup-receipt") receiptPath = requiredValue(args, ++index, "--backup-receipt");
		else if (argument.startsWith("-")) throw new AuthBrokerCommandError(`Unknown auth-broker option: ${argument}`);
		else if (source === undefined) source = argument;
		else throw new AuthBrokerCommandError("Auth-broker command accepts one positional argument");
	}
	if ((action === "login" || action === "logout" || action === "import") && source === undefined)
		throw new AuthBrokerCommandError(`auth-broker ${action} requires a source argument`);
	if (action === "migrate" && !args.includes("--from-local"))
		throw new AuthBrokerCommandError("auth-broker migrate requires --from-local");
	if (action !== "serve" && bind !== undefined)
		throw new AuthBrokerCommandError("--bind is only valid for auth-broker serve");
	return { action, bind, dryRun, includeDisabled, json, provider, receiptPath, regenerate, source, identity };
}

function isAction(value: string | undefined): value is BrokerAction {
	return (
		value === "serve" ||
		value === "token" ||
		value === "status" ||
		value === "login" ||
		value === "logout" ||
		value === "import" ||
		value === "migrate"
	);
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
	const value = args[index];
	if (value === undefined || value.startsWith("-")) throw new AuthBrokerCommandError(`${flag} requires a value`);
	return value;
}

function agentDirectory(options: AuthBrokerCommandOptions): string {
	return options.agentDir ?? getAgentDir();
}

async function execute(command: ParsedCommand, agentDir: string): Promise<AuthBrokerCommandExecution> {
	await ensureDirectory(agentDir);
	switch (command.action) {
		case "token":
			return tokenCommand(command, agentDir);
		case "status":
			return statusCommand(command, agentDir);
		case "import":
			return importCommand(command, agentDir);
		case "migrate":
			return migrateCommand(command, agentDir);
		case "logout":
			return logoutCommand(command, agentDir);
		case "login":
			return loginCommand(command, agentDir);
		case "serve":
			return serveCommand(command, agentDir);
	}
}

async function tokenCommand(command: ParsedCommand, agentDir: string): Promise<AuthBrokerCommandExecution> {
	const token = command.regenerate ? await replaceToken(agentDir) : await ensureToken(agentDir);
	const path = tokenPath(agentDir);
	return { exitCode: 0, stderr: "", stdout: command.json ? `${JSON.stringify({ path, token })}\n` : `${token}\n` };
}

async function statusCommand(command: ParsedCommand, agentDir: string): Promise<AuthBrokerCommandExecution> {
	const token = await readToken(agentDir);
	const vault = SqliteCredentialVault.open(vaultPath(agentDir));
	try {
		const status = {
			credentialCount: vault.load().length,
			tokenFile: tokenPath(agentDir),
			tokenPresent: token !== undefined,
			vault: vaultPath(agentDir),
		};
		return {
			exitCode: 0,
			stderr: "",
			stdout: command.json
				? `${JSON.stringify(status)}\n`
				: `credentials: ${status.credentialCount}\ntoken: ${status.tokenPresent ? "present" : "missing"}\n`,
		};
	} finally {
		vault.close();
	}
}

async function logoutCommand(command: ParsedCommand, agentDir: string): Promise<AuthBrokerCommandExecution> {
	const provider = command.source;
	if (provider === undefined) throw new AuthBrokerCommandError("auth-broker logout requires a provider");
	const vault = SqliteCredentialVault.open(vaultPath(agentDir));
	try {
		const deleted = command.dryRun
			? vault.load().filter((credential) => credential.pool.provider === provider).length
			: vault.deleteCredentialsForProvider(provider);
		return {
			exitCode: 0,
			stderr: "",
			stdout: command.json
				? `${JSON.stringify({ deleted, dryRun: command.dryRun, provider })}\n`
				: `${command.dryRun ? "Would remove" : "Removed"} ${deleted} credential(s) for ${provider}\n`,
		};
	} finally {
		vault.close();
	}
}

async function loginCommand(command: ParsedCommand, agentDir: string): Promise<AuthBrokerCommandExecution> {
	const providerId = command.source;
	if (providerId === undefined) throw new AuthBrokerCommandError("auth-broker login requires a provider");
	const provider = getOAuthProvider(providerId);
	if (provider === undefined) throw new AuthBrokerCommandError(`Unknown OAuth provider: ${providerId}`);
	if (command.dryRun) return { exitCode: 0, stderr: "", stdout: `Would start OAuth login for ${providerId}\n` };
	const credentials = await provider.login(loginCallbacks());
	const vault = SqliteCredentialVault.open(vaultPath(agentDir));
	try {
		vault.upsertCredential(oauthRecord(providerId, command.identity ?? `oauth:${providerId}`, credentials));
	} finally {
		vault.close();
	}
	return { exitCode: 0, stderr: "", stdout: `Logged in to ${providerId}\n` };
}

async function serveCommand(command: ParsedCommand, agentDir: string): Promise<AuthBrokerCommandExecution> {
	const bind = parseAuthBrokerBind(command.bind ?? "127.0.0.1:8765");
	const token = await ensureToken(agentDir);
	const vault = SqliteCredentialVault.open(vaultPath(agentDir));
	const broker = new AuthBrokerService(vault, [
		{ authentication: token, capabilities: ALL_CAPABILITIES, trustedGateway: true },
	]);
	const handle = await startAuthBrokerServer({ bind, broker, version: VERSION });
	let resolveStop: (() => void) | undefined;
	const stopped = new Promise<void>((resolveStopPromise) => {
		resolveStop = resolveStopPromise;
	});
	const shutdown = (): void => resolveStop?.();
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	try {
		await stopped;
	} finally {
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		await handle.close();
		vault.close();
	}
	return { exitCode: 0, stderr: "", stdout: `auth-broker stopped (${handle.url})\n` };
}

function loginCallbacks(): OAuthLoginCallbacks {
	return {
		onAuth: ({ url }) => process.stdout.write(`${url}\n`),
		onDeviceCode: ({ userCode, verificationUri }) => process.stdout.write(`${verificationUri} ${userCode}\n`),
		onPrompt: async ({ message }) => prompt(message),
		onSelect: async ({ message, options }) =>
			prompt(`${message}\n${options.map(({ id, label }) => `${id}: ${label}`).join("\n")}`),
	};
}

async function prompt(message: string): Promise<string> {
	const reader = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await new Promise<string>((resolvePrompt) => reader.question(`${message}: `, resolvePrompt));
	} finally {
		reader.close();
	}
}

function oauthRecord(provider: string, identityKey: string, credentials: OAuthCredentials): CredentialRecord {
	return {
		createdAt: new Date().toISOString(),
		credentialId: randomUUID(),
		identityKey,
		material: {
			accessToken: credentials.access,
			expiresAt: credentials.expires,
			refreshToken: credentials.refresh,
			type: "oauth",
		},
		pool: { provider, type: "oauth" },
		updatedAt: new Date().toISOString(),
	};
}

function tokenPath(agentDir: string): string {
	return join(agentDir, TOKEN_FILE);
}

function vaultPath(agentDir: string): string {
	return join(agentDir, VAULT_FILE);
}

async function ensureDirectory(agentDir: string): Promise<void> {
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await chmod(agentDir, 0o700);
}

async function readToken(agentDir: string): Promise<string | undefined> {
	try {
		const token = (await readFile(tokenPath(agentDir), "utf8")).trim();
		return token || undefined;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function ensureToken(agentDir: string): Promise<string> {
	await ensureDirectory(agentDir);
	const current = await readToken(agentDir);
	if (current !== undefined) return current;
	for (let attempt = 0; attempt < 3; attempt++) {
		const candidate = randomBytes(32).toString("base64url");
		try {
			const file = await open(tokenPath(agentDir), "wx", 0o600);
			try {
				await file.writeFile(`${candidate}\n`);
				await file.chmod(0o600);
			} finally {
				await file.close();
			}
			return candidate;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			const winner = await readToken(agentDir);
			if (winner !== undefined) return winner;
		}
	}
	throw new AuthBrokerCommandError("Unable to create broker token safely");
}

async function replaceToken(agentDir: string): Promise<string> {
	await ensureDirectory(agentDir);
	const token = randomBytes(32).toString("base64url");
	const temporary = `${tokenPath(agentDir)}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${token}\n`, { flag: "wx", mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, tokenPath(agentDir));
	await chmod(tokenPath(agentDir), 0o600);
	return token;
}

async function importCommand(command: ParsedCommand, agentDir: string): Promise<AuthBrokerCommandExecution> {
	const source = command.source;
	if (source === undefined) throw new AuthBrokerCommandError("auth-broker import requires a file or directory");
	const records = await loadImportRecords(resolve(source), command.provider, command.includeDisabled);
	if (!command.dryRun) {
		const vault = SqliteCredentialVault.open(vaultPath(agentDir));
		try {
			for (const record of records) vault.upsertCredential(record);
		} finally {
			vault.close();
		}
	}
	const result = {
		dryRun: command.dryRun,
		imported: command.dryRun ? 0 : records.length,
		planned: records.map(redactedRecord),
	};
	return {
		exitCode: 0,
		stderr: "",
		stdout: command.json
			? `${JSON.stringify(result)}\n`
			: `${command.dryRun ? "Would import" : "Imported"} ${records.length} credential(s)\n`,
	};
}

async function loadImportRecords(
	source: string,
	overrideProvider: string | undefined,
	includeDisabled: boolean,
): Promise<readonly CredentialRecord[]> {
	const files = await importFiles(source);
	const records: CredentialRecord[] = [];
	for (const file of files) {
		const value = parseJsonRecord(await readFile(file, "utf8"));
		if (value.disabled === true && !includeDisabled) continue;
		const provider = overrideProvider ?? providerForImport(value.type);
		if (provider === undefined) throw new AuthBrokerCommandError("Unsupported import credential type");
		const access = requiredString(value, "access_token");
		const refresh = requiredString(value, "refresh_token");
		const expires = Date.parse(requiredString(value, "expired"));
		if (!Number.isFinite(expires)) throw new AuthBrokerCommandError("Import credential has invalid expiry");
		const identityKey =
			optionalString(value, "email") ?? optionalString(value, "account_id") ?? `import:${basename(file)}`;
		records.push({
			createdAt: new Date().toISOString(),
			credentialId: randomUUID(),
			identityKey,
			material: { accessToken: access, expiresAt: expires, refreshToken: refresh, type: "oauth" },
			pool: { provider, type: "oauth" },
			updatedAt: new Date().toISOString(),
		});
	}
	return records;
}

async function importFiles(source: string): Promise<readonly string[]> {
	const sourceStat = await stat(source);
	if (sourceStat.isFile()) return [source];
	if (!sourceStat.isDirectory()) throw new AuthBrokerCommandError("Import source must be a JSON file or directory");
	const entries = await readdir(source, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => join(source, entry.name))
		.sort();
}

function providerForImport(value: unknown): string | undefined {
	switch (value) {
		case "claude":
		case "anthropic-model":
			return "anthropic";
		case "codex":
		case "openai-code":
			return "openai-codex";
		case "gemini":
		case "gemini-cli":
			return "google-gemini-cli";
		case "antigravity":
			return "google-antigravity";
		default:
			return undefined;
	}
}

async function migrateCommand(command: ParsedCommand, agentDir: string): Promise<AuthBrokerCommandExecution> {
	if (command.receiptPath === undefined)
		throw new AuthBrokerCommandError("Migration requires --backup-receipt created by a dry-run");
	const sourcePath = join(agentDir, "auth.json");
	const source = await readFile(sourcePath, "utf8");
	const receiptPath = resolve(command.receiptPath);
	const backupPath = `${receiptPath}.backup`;
	const provenancePath = `${receiptPath}.provenance`;
	const sourceSha256 = hash(source);
	if (command.dryRun) {
		await ensureDirectory(dirname(receiptPath));
		await writeFile(backupPath, source, { mode: 0o600 });
		await chmod(backupPath, 0o600);
		const backupSha256 = hash(await readFile(backupPath, "utf8"));
		const provenance = { backupPath, backupSha256, nonce: randomUUID(), sourcePath, sourceSha256, version: 1 };
		await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`, { mode: 0o600 });
		await chmod(provenancePath, 0o600);
		const receipt = {
			backupPath,
			backupSha256,
			provenancePath,
			provenanceSha256: hash(JSON.stringify(provenance)),
			sourcePath,
			sourceSha256,
			version: 2,
		};
		await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
		await chmod(receiptPath, 0o600);
		return {
			exitCode: 0,
			stderr: "",
			stdout: command.json
				? `${JSON.stringify({ dryRun: true, receiptPath })}\n`
				: `Dry-run receipt written to ${receiptPath}\n`,
		};
	}
	const saved = parseJsonRecord(await readFile(receiptPath, "utf8"));
	if (
		saved.version !== 2 ||
		saved.sourcePath !== sourcePath ||
		saved.sourceSha256 !== sourceSha256 ||
		saved.backupPath !== backupPath ||
		saved.provenancePath !== provenancePath ||
		typeof saved.backupSha256 !== "string" ||
		typeof saved.provenanceSha256 !== "string"
	)
		throw new AuthBrokerCommandError("Migration backup receipt is invalid or stale");
	const backup = await readFile(backupPath, "utf8");
	if (backup !== source || hash(backup) !== saved.backupSha256)
		throw new AuthBrokerCommandError("Migration backup receipt is invalid or stale");
	const provenance = parseJsonRecord(await readFile(provenancePath, "utf8"));
	if (
		hash(JSON.stringify(provenance)) !== saved.provenanceSha256 ||
		provenance.version !== 1 ||
		provenance.sourcePath !== sourcePath ||
		provenance.sourceSha256 !== sourceSha256 ||
		provenance.backupPath !== backupPath ||
		provenance.backupSha256 !== saved.backupSha256 ||
		typeof provenance.nonce !== "string" ||
		provenance.nonce.length < 20
	)
		throw new AuthBrokerCommandError("Migration backup receipt is invalid or stale");
	const records = localAuthRecords(parseJsonRecord(source));
	const vault = SqliteCredentialVault.open(vaultPath(agentDir));
	try {
		for (const record of records) vault.upsertCredential(record);
	} finally {
		vault.close();
	}
	return {
		exitCode: 0,
		stderr: "",
		stdout: command.json
			? `${JSON.stringify({ migrated: records.length })}\n`
			: `Migrated ${records.length} credential(s)\n`,
	};
}

function localAuthRecords(value: Record<string, unknown>): readonly CredentialRecord[] {
	const records: CredentialRecord[] = [];
	for (const [provider, raw] of Object.entries(value)) {
		const credential = parseJsonRecord(raw);
		const now = new Date().toISOString();
		if (credential.type === "api_key" && typeof credential.key === "string") {
			records.push({
				createdAt: now,
				credentialId: randomUUID(),
				identityKey: `local:${provider}`,
				material: { apiKey: credential.key, type: "api_key" },
				pool: { provider, type: "api_key" },
				updatedAt: now,
			});
		} else if (credential.type === "oauth") {
			const material = oauthMaterial(credential);
			records.push({
				createdAt: now,
				credentialId: randomUUID(),
				identityKey: `local:${provider}`,
				material,
				pool: { provider, type: "oauth" },
				updatedAt: now,
			});
		}
	}
	return records;
}

function oauthMaterial(record: Record<string, unknown>): Extract<CredentialMaterial, { readonly type: "oauth" }> {
	const accessToken = requiredString(record, "access");
	const refreshToken = requiredString(record, "refresh");
	const expiresAt = record.expires;
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
		throw new AuthBrokerCommandError("Local OAuth credential has invalid expiry");
	return { accessToken, expiresAt, refreshToken, type: "oauth" };
}

function redactedRecord(record: CredentialRecord): {
	readonly identityKey: string;
	readonly provider: string;
	readonly type: string;
} {
	return { identityKey: record.identityKey, provider: record.pool.provider, type: record.pool.type };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "string") {
		try {
			return parseJsonRecord(JSON.parse(value));
		} catch (error) {
			if (error instanceof SyntaxError) throw new AuthBrokerCommandError("Invalid credential JSON");
			throw error;
		}
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new AuthBrokerCommandError("Invalid credential JSON");
	return Object.fromEntries(Object.entries(value));
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0)
		throw new AuthBrokerCommandError("Credential data is incomplete");
	return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
