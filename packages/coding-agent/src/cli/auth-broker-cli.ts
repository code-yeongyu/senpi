import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { getAgentDir, VERSION } from "../config.ts";
import { AuthBrokerService, SqliteCredentialVault } from "../core/auth-broker.ts";
import { AuthBrokerRefresher } from "../core/auth-broker-refresher.ts";
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
  import <file> [--format=<format>] [--dry-run]
                                     Import Senpi backup v1 or CLIProxyAPI v6 JSON.
  backup <file>                      Write a permission-locked Senpi backup v1 export.
  restore <file> [--dry-run]         Validate and restore a Senpi backup v1 export.
  migrate --from-local --dry-run --backup-receipt=<path>
                                     Create a receipt before a destructive migration.

GET /healthz is unauthenticated. POST /v1/broker requires this command's Bearer token.
External binds are rejected.
`;

type BrokerAction = "serve" | "token" | "status" | "login" | "logout" | "import" | "backup" | "restore" | "migrate";

type ParsedCommand = {
	readonly action: BrokerAction;
	readonly bind?: string;
	readonly dryRun: boolean;
	readonly format?: string;
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
	let format: string | undefined;
	let json = false;
	let provider: string | undefined;
	let receiptPath: string | undefined;
	let regenerate = false;
	let source: string | undefined;
	let identity: string | undefined;
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--dry-run") dryRun = true;
		else if (argument.startsWith("--format=")) format = argument.slice("--format=".length);
		else if (argument === "--format") format = requiredValue(args, ++index, "--format");
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
	if (
		(action === "login" ||
			action === "logout" ||
			action === "import" ||
			action === "backup" ||
			action === "restore") &&
		source === undefined
	)
		throw new AuthBrokerCommandError(`auth-broker ${action} requires a source argument`);
	if (action === "migrate" && !args.includes("--from-local"))
		throw new AuthBrokerCommandError("auth-broker migrate requires --from-local");
	if (format !== undefined && action !== "import")
		throw new AuthBrokerCommandError("--format is only valid for auth-broker import");
	if (action !== "serve" && bind !== undefined)
		throw new AuthBrokerCommandError("--bind is only valid for auth-broker serve");
	return { action, bind, dryRun, format, json, provider, receiptPath, regenerate, source, identity };
}

function isAction(value: string | undefined): value is BrokerAction {
	return (
		value === "serve" ||
		value === "token" ||
		value === "status" ||
		value === "login" ||
		value === "logout" ||
		value === "import" ||
		value === "backup" ||
		value === "restore" ||
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
		case "backup":
			return backupCommand(command, agentDir);
		case "restore":
			return restoreCommand(command, agentDir);
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
	const broker = new AuthBrokerService(
		vault,
		[{ authentication: token, capabilities: ALL_CAPABILITIES, trustedGateway: true }],
		refreshOAuthCredential,
	);
	const refresher = new AuthBrokerRefresher({ service: broker });
	const handle = await startAuthBrokerServer({ bind, broker, version: VERSION });
	refresher.start();
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
		refresher.stop();
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

const refreshOAuthCredential = async (record: CredentialRecord): Promise<CredentialMaterial> => {
	if (record.material.type !== "oauth") throw new AuthBrokerCommandError("Only OAuth credentials can be refreshed");
	const provider = getOAuthProvider(record.pool.provider);
	if (provider === undefined) throw new AuthBrokerCommandError(`Unknown OAuth provider: ${record.pool.provider}`);
	const refreshed = await provider.refreshToken({
		access: record.material.accessToken,
		expires: record.material.expiresAt,
		refresh: record.material.refreshToken,
	});
	return {
		accessToken: refreshed.access,
		expiresAt: refreshed.expires,
		refreshToken: refreshed.refresh,
		type: "oauth",
	};
};

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
	if (source === undefined) throw new AuthBrokerCommandError("auth-broker import requires a file");
	const records = await loadImportRecords(resolve(source), command.format, command.provider);
	if (command.dryRun) {
		assertNoIdentityConflicts(records, await existingCredentials(agentDir));
	} else {
		const vault = SqliteCredentialVault.open(vaultPath(agentDir));
		try {
			assertNoIdentityConflicts(records, vault.load());
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

async function existingCredentials(agentDir: string): Promise<readonly CredentialRecord[]> {
	try {
		await stat(vaultPath(agentDir));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const vault = SqliteCredentialVault.open(vaultPath(agentDir));
	try {
		return vault.load();
	} finally {
		vault.close();
	}
}

async function loadImportRecords(
	source: string,
	format: string | undefined,
	overrideProvider: string | undefined,
): Promise<readonly CredentialRecord[]> {
	const sourceStat = await stat(source);
	if (!sourceStat.isFile()) throw new AuthBrokerCommandError("Import source must be a JSON file");
	const value = parseJsonRecord(await readFile(source, "utf8"));
	if (format === "gajae-snapshot-legacy") return gajaeSnapshotRecords(value, overrideProvider);
	if (format !== undefined) throw new AuthBrokerCommandError("Unknown import format");
	if (value.format === "senpi-auth-broker-backup") {
		assertPermissionLocked(sourceStat.mode);
		return senpiBackupRecords(value);
	}
	if (value.version === 6) return cliProxyV6Records(value, overrideProvider);
	throw new AuthBrokerCommandError("Unknown import format or version");
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

async function backupCommand(command: ParsedCommand, agentDir: string): Promise<AuthBrokerCommandExecution> {
	const destination = command.source;
	if (destination === undefined) throw new AuthBrokerCommandError("auth-broker backup requires a file");
	const vault = SqliteCredentialVault.open(vaultPath(agentDir));
	try {
		const credentials = vault.load();
		await writeLockedJson(resolve(destination), {
			credentials,
			format: "senpi-auth-broker-backup",
			manifest: { algorithm: "sha256", credentialsSha256: hashJson(credentials) },
			version: 1,
		});
	} finally {
		vault.close();
	}
	return { exitCode: 0, stderr: "", stdout: `Backup written to ${resolve(destination)}\n` };
}

async function restoreCommand(command: ParsedCommand, agentDir: string): Promise<AuthBrokerCommandExecution> {
	const source = command.source;
	if (source === undefined) throw new AuthBrokerCommandError("auth-broker restore requires a file");
	const resolvedSource = resolve(source);
	assertPermissionLocked((await stat(resolvedSource)).mode);
	const records = senpiBackupRecords(parseJsonRecord(await readFile(resolvedSource, "utf8")));
	if (!command.dryRun) {
		const vault = SqliteCredentialVault.open(vaultPath(agentDir));
		try {
			assertNoDuplicateIdentity(records);
			vault.save(records);
		} finally {
			vault.close();
		}
	}
	return {
		exitCode: 0,
		stderr: "",
		stdout: `${command.dryRun ? "Would restore" : "Restored"} ${records.length} credential(s)\n`,
	};
}

function senpiBackupRecords(value: Record<string, unknown>): readonly CredentialRecord[] {
	assertExactKeys(value, ["credentials", "format", "manifest", "version"]);
	if (value.format !== "senpi-auth-broker-backup" || value.version !== 1)
		throw new AuthBrokerCommandError("Unknown Senpi backup version");
	const credentials = requiredArray(value, "credentials");
	const manifest = parseJsonRecord(value.manifest);
	assertExactKeys(manifest, ["algorithm", "credentialsSha256"]);
	if (manifest.algorithm !== "sha256" || manifest.credentialsSha256 !== hashJson(credentials))
		throw new AuthBrokerCommandError("Backup manifest hash is invalid");
	const records = credentials.map((entry) => senpiCredentialRecord(parseJsonRecord(entry)));
	assertNoDuplicateIdentity(records);
	return records;
}

function senpiCredentialRecord(value: Record<string, unknown>): CredentialRecord {
	assertExactKeys(value, ["createdAt", "credentialId", "disabled", "identityKey", "material", "pool", "updatedAt"]);
	const pool = parseJsonRecord(value.pool);
	assertExactKeys(pool, ["provider", "type"]);
	const provider = requiredString(pool, "provider");
	const type = credentialType(pool.type);
	const material = parseCredentialMaterial(parseJsonRecord(value.material), type);
	const disabled = parseDisabled(value.disabled, requiredTimestamp(value, "updatedAt"));
	return {
		createdAt: requiredTimestamp(value, "createdAt"),
		credentialId: requiredString(value, "credentialId"),
		disabled,
		identityKey: requiredString(value, "identityKey"),
		material,
		pool: { provider, type },
		updatedAt: requiredTimestamp(value, "updatedAt"),
	};
}

function gajaeSnapshotRecords(
	value: Record<string, unknown>,
	overrideProvider: string | undefined,
): readonly CredentialRecord[] {
	assertExactKeys(value, ["credentials", "generatedAt", "generation"]);
	if (
		!Number.isInteger(value.generation) ||
		typeof value.generatedAt !== "number" ||
		!Number.isFinite(value.generatedAt)
	)
		throw new AuthBrokerCommandError("Invalid Gajae snapshot");
	const timestamp = new Date(value.generatedAt).toISOString();
	const records = requiredArray(value, "credentials").map((entry) => {
		const snapshot = parseJsonRecord(entry);
		assertExactKeys(snapshot, ["credential", "id", "identityKey", "provider"]);
		if (!Number.isInteger(snapshot.id)) throw new AuthBrokerCommandError("Invalid Gajae snapshot credential");
		const credential = parseJsonRecord(snapshot.credential);
		const provider = overrideProvider ?? requiredString(snapshot, "provider");
		const identityKey = optionalNullableString(snapshot, "identityKey") ?? `gajae:${snapshot.id}`;
		return recordFromGajaeCredential(credential, provider, identityKey, timestamp);
	});
	assertNoDuplicateIdentity(records);
	return records;
}

function recordFromGajaeCredential(
	credential: Record<string, unknown>,
	provider: string,
	identityKey: string,
	timestamp: string,
): CredentialRecord {
	if (credential.type === "api_key") {
		assertExactKeys(credential, ["key", "type"]);
		return credentialRecord(
			provider,
			identityKey,
			{ apiKey: requiredString(credential, "key"), type: "api_key" },
			timestamp,
		);
	}
	if (credential.type === "oauth") {
		assertExactKeys(credential, ["access", "expires", "refresh", "type"]);
		const expiresAt = requiredFiniteNumber(credential, "expires");
		return credentialRecord(
			provider,
			identityKey,
			{
				accessToken: requiredString(credential, "access"),
				expiresAt,
				refreshToken: requiredString(credential, "refresh"),
				type: "oauth",
			},
			timestamp,
		);
	}
	throw new AuthBrokerCommandError("Unsupported Gajae credential kind");
}

function cliProxyV6Records(
	value: Record<string, unknown>,
	overrideProvider: string | undefined,
): readonly CredentialRecord[] {
	assertExactKeys(value, ["credentials", "version"]);
	if (value.version !== 6) throw new AuthBrokerCommandError("Unknown CLIProxyAPI version");
	const records = requiredArray(value, "credentials").map((entry) =>
		cliProxyV6Record(parseJsonRecord(entry), overrideProvider),
	);
	assertNoDuplicateIdentity(records);
	return records;
}

function cliProxyV6Record(value: Record<string, unknown>, overrideProvider: string | undefined): CredentialRecord {
	assertExactKeys(value, [
		"access_token",
		"account_id",
		"created_at",
		"disabled",
		"email",
		"expired",
		"project_id",
		"provider",
		"refresh_token",
		"type",
		"updated_at",
	]);
	const mappedProvider = providerForImport(value.type);
	if (mappedProvider === undefined) throw new AuthBrokerCommandError("Unsupported CLIProxyAPI credential kind");
	const provider = overrideProvider ?? mappedProvider;
	const identityKey =
		optionalString(value, "email") ?? optionalString(value, "account_id") ?? optionalString(value, "project_id");
	if (identityKey === undefined) throw new AuthBrokerCommandError("CLIProxyAPI credential has no supported identity");
	const expiresAt = Date.parse(requiredString(value, "expired"));
	if (!Number.isFinite(expiresAt)) throw new AuthBrokerCommandError("CLIProxyAPI credential has invalid expiry");
	const updatedAt =
		optionalTimestamp(value, "updated_at") ?? optionalTimestamp(value, "created_at") ?? new Date().toISOString();
	return {
		...credentialRecord(
			provider,
			identityKey,
			{
				accessToken: requiredString(value, "access_token"),
				expiresAt,
				refreshToken: requiredString(value, "refresh_token"),
				type: "oauth",
			},
			optionalTimestamp(value, "created_at") ?? updatedAt,
		),
		disabled: parseDisabled(value.disabled, updatedAt),
		updatedAt,
	};
}

function credentialRecord(
	provider: string,
	identityKey: string,
	material: CredentialMaterial,
	timestamp: string,
): CredentialRecord {
	return {
		createdAt: timestamp,
		credentialId: randomUUID(),
		identityKey,
		material,
		pool: { provider, type: material.type },
		updatedAt: timestamp,
	};
}

function parseCredentialMaterial(value: Record<string, unknown>, type: CredentialMaterial["type"]): CredentialMaterial {
	if (type === "api_key") {
		assertExactKeys(value, ["apiKey", "type"]);
		if (value.type !== "api_key") throw new AuthBrokerCommandError("Credential material kind does not match pool");
		return { apiKey: requiredString(value, "apiKey"), type };
	}
	assertExactKeys(value, ["accessToken", "expiresAt", "refreshToken", "type"]);
	if (value.type !== "oauth") throw new AuthBrokerCommandError("Credential material kind does not match pool");
	return {
		accessToken: requiredString(value, "accessToken"),
		expiresAt: requiredFiniteNumber(value, "expiresAt"),
		refreshToken: requiredString(value, "refreshToken"),
		type,
	};
}

function credentialType(value: unknown): CredentialMaterial["type"] {
	if (value === "api_key" || value === "oauth") return value;
	throw new AuthBrokerCommandError("Unsupported credential kind");
}

function parseDisabled(value: unknown, timestamp: string): CredentialRecord["disabled"] {
	if (value === undefined) return undefined;
	if (value === false) return undefined;
	if (value === true) return { at: timestamp, cause: "disabled" };
	const disabled = parseJsonRecord(value);
	assertExactKeys(disabled, ["at", "cause"]);
	return { at: optionalTimestamp(disabled, "at") ?? timestamp, cause: requiredString(disabled, "cause") };
}

function assertNoIdentityConflicts(records: readonly CredentialRecord[], existing: readonly CredentialRecord[]): void {
	assertNoDuplicateIdentity(records);
	const keys = new Set(existing.map(identityConflictKey));
	if (records.some((record) => keys.has(identityConflictKey(record))))
		throw new AuthBrokerCommandError("Import conflicts with an existing credential identity");
}

function assertNoDuplicateIdentity(records: readonly CredentialRecord[]): void {
	const keys = new Set<string>();
	for (const record of records) {
		const key = identityConflictKey(record);
		if (keys.has(key)) throw new AuthBrokerCommandError("Import contains duplicate credential identity");
		keys.add(key);
	}
}

function identityConflictKey(record: CredentialRecord): string {
	return `${record.pool.provider}\u0000${record.pool.type}\u0000${record.identityKey}`;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new AuthBrokerCommandError("Import contains unknown fields");
}

function assertPermissionLocked(mode: number): void {
	if ((mode & 0o077) !== 0) throw new AuthBrokerCommandError("Senpi backup must be permission-locked (0600)");
}

function requiredArray(value: Record<string, unknown>, key: string): readonly unknown[] {
	const candidate = value[key];
	if (!Array.isArray(candidate)) throw new AuthBrokerCommandError("Import data is incomplete");
	return candidate;
}

function requiredFiniteNumber(value: Record<string, unknown>, key: string): number {
	const candidate = value[key];
	if (typeof candidate !== "number" || !Number.isFinite(candidate))
		throw new AuthBrokerCommandError("Import data is incomplete");
	return candidate;
}

function requiredTimestamp(value: Record<string, unknown>, key: string): string {
	const timestamp = requiredString(value, key);
	if (!Number.isFinite(Date.parse(timestamp))) throw new AuthBrokerCommandError("Import data has invalid timestamp");
	return timestamp;
}

function optionalTimestamp(value: Record<string, unknown>, key: string): string | undefined {
	const timestamp = optionalString(value, key);
	if (timestamp !== undefined && !Number.isFinite(Date.parse(timestamp)))
		throw new AuthBrokerCommandError("Import data has invalid timestamp");
	return timestamp;
}

function optionalNullableString(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	if (candidate === undefined || candidate === null) return undefined;
	if (typeof candidate !== "string" || candidate.length === 0)
		throw new AuthBrokerCommandError("Import data is incomplete");
	return candidate;
}

async function writeLockedJson(destination: string, value: unknown): Promise<void> {
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	await writeFile(destination, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
	await chmod(destination, 0o600);
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

function hashJson(value: unknown): string {
	return hash(JSON.stringify(value));
}
