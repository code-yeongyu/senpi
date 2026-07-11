import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, VERSION } from "../config.ts";
import { AuthBrokerRemoteStore } from "../core/auth-broker-remote-store.ts";
import { parseAuthBrokerWireResponse } from "../core/auth-broker-wire-contract.ts";
import {
	type AuthGatewayAuthorizedModel,
	createAuthGatewayObservabilityHandler,
} from "../core/auth-gateway-observability.ts";
import { type AuthGatewayTransportHandle, startAuthGatewayTransport } from "../core/auth-gateway-transport.ts";

const DEFAULT_BIND = "127.0.0.1:4000";
const GATEWAY_TOKEN_FILE = "auth-gateway.token";
const BROKER_TOKEN_FILE = "auth-broker.token";

const AUTH_GATEWAY_USAGE = `Usage: senpi auth-gateway <command>

Commands:
  serve [--bind=127.0.0.1:4000] [--model=provider/model]...
                                  Start a gateway backed by the configured broker.
  token [--regenerate] [--json]  Create or rotate the gateway bearer token.
  status [--json]                Show redacted gateway and broker status.
  check [--json]                 List broker credential health without secrets.
`;

type AuthGatewayAction = "serve" | "token" | "status" | "check";

type ParsedCommand = {
	readonly action: AuthGatewayAction;
	readonly bind?: string;
	readonly json: boolean;
	readonly models: readonly AuthGatewayAuthorizedModel[];
	readonly regenerate: boolean;
};

type BrokerConfig = {
	readonly token: string;
	readonly url: string;
};

export type AuthGatewayCommandExecution = {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
};

export type AuthGatewayCommandOptions = {
	readonly agentDir?: string;
	readonly brokerToken?: string;
	readonly brokerUrl?: string;
	readonly onGatewayStarted?: (handle: AuthGatewayTransportHandle) => Promise<void>;
};

export async function handleAuthGatewayCommand(args: readonly string[]): Promise<boolean> {
	const result = await executeAuthGatewayCommand(args);
	if (result === undefined) return false;
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exitCode = result.exitCode;
	return true;
}

export async function executeAuthGatewayCommand(
	args: readonly string[],
	options: AuthGatewayCommandOptions = {},
): Promise<AuthGatewayCommandExecution | undefined> {
	if (args[0] !== "auth-gateway") return undefined;
	if (args[1] === undefined || args[1] === "--help" || args[1] === "-h") {
		return { exitCode: 0, stderr: "", stdout: AUTH_GATEWAY_USAGE };
	}
	try {
		return await execute(parseCommand(args.slice(1)), options);
	} catch (error) {
		const usageError = error instanceof AuthGatewayCommandError;
		const message = usageError ? error.message : "Auth gateway command failed";
		return { exitCode: usageError ? 2 : 1, stderr: `Error: ${message}\n`, stdout: "" };
	}
}

class AuthGatewayCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthGatewayCommandError";
	}
}

function parseCommand(args: readonly string[]): ParsedCommand {
	const action = args[0];
	if (!isAction(action)) throw new AuthGatewayCommandError(AUTH_GATEWAY_USAGE.trim());
	let bind: string | undefined;
	let json = false;
	const models: AuthGatewayAuthorizedModel[] = [];
	let regenerate = false;
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--json") json = true;
		else if (argument === "--regenerate" && action === "token") regenerate = true;
		else if (argument.startsWith("--model=")) models.push(parseAuthorizedModel(argument.slice("--model=".length)));
		else if (argument === "--model") models.push(parseAuthorizedModel(requiredValue(args, ++index, "--model")));
		else if (argument.startsWith("--bind=")) bind = argument.slice("--bind=".length);
		else if (argument === "--bind") bind = requiredValue(args, ++index, "--bind");
		else throw new AuthGatewayCommandError(`Unknown auth-gateway option: ${argument}`);
	}
	if (action !== "serve" && bind !== undefined) {
		throw new AuthGatewayCommandError("--bind is only valid for auth-gateway serve");
	}
	if (action !== "token" && regenerate) {
		throw new AuthGatewayCommandError("--regenerate is only valid for auth-gateway token");
	}
	if (action !== "serve" && models.length > 0) {
		throw new AuthGatewayCommandError("--model is only valid for auth-gateway serve");
	}
	return { action, bind, json, models, regenerate };
}

function isAction(value: string | undefined): value is AuthGatewayAction {
	return value === "serve" || value === "token" || value === "status" || value === "check";
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
	const value = args[index];
	if (value === undefined || value.startsWith("-")) throw new AuthGatewayCommandError(`${flag} requires a value`);
	return value;
}

function parseAuthorizedModel(value: string): AuthGatewayAuthorizedModel {
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new AuthGatewayCommandError("--model must use provider/model format");
	}
	return { modelId: value.slice(separator + 1), provider: value.slice(0, separator) };
}

async function execute(
	command: ParsedCommand,
	options: AuthGatewayCommandOptions,
): Promise<AuthGatewayCommandExecution> {
	switch (command.action) {
		case "token":
			return tokenCommand(command, agentDirectory(options));
		case "status":
			return statusCommand(command, options);
		case "check":
			return checkCommand(command, options);
		case "serve":
			return serveCommand(command, options);
	}
}

async function tokenCommand(command: ParsedCommand, agentDir: string): Promise<AuthGatewayCommandExecution> {
	const token = command.regenerate ? await replaceGatewayToken(agentDir) : await gatewayToken(agentDir);
	const path = gatewayTokenPath(agentDir);
	return { exitCode: 0, stderr: "", stdout: command.json ? `${JSON.stringify({ path, token })}\n` : `${token}\n` };
}

async function statusCommand(
	command: ParsedCommand,
	options: AuthGatewayCommandOptions,
): Promise<AuthGatewayCommandExecution> {
	const agentDir = agentDirectory(options);
	const tokenPresent = (await readToken(gatewayTokenPath(agentDir))) !== undefined;
	const broker = await brokerConfig(options, false);
	if (broker === undefined) {
		return statusResult(command.json, {
			brokerConfigured: false,
			credentialCount: 0,
			gatewayTokenPresent: tokenPresent,
			ready: false,
		});
	}
	const snapshot = await snapshotFor(broker);
	return statusResult(command.json, {
		brokerConfigured: true,
		credentialCount: snapshot.credentials.length,
		gatewayTokenPresent: tokenPresent,
		ready: tokenPresent,
	});
}

async function checkCommand(
	command: ParsedCommand,
	options: AuthGatewayCommandOptions,
): Promise<AuthGatewayCommandExecution> {
	const broker = await requiredBrokerConfig(options);
	const snapshot = await snapshotFor(broker);
	const credentials = snapshot.credentials.map((credential) => ({
		credentialId: credential.credentialId,
		disabled: credential.disabled !== undefined,
		provider: credential.pool.provider,
		type: credential.pool.type,
	}));
	const failed = credentials.filter((credential) => credential.disabled).length;
	if (command.json) {
		return { exitCode: failed === 0 ? 0 : 1, stderr: "", stdout: `${JSON.stringify({ credentials })}\n` };
	}
	const lines = credentials.map(
		(credential) =>
			`${credential.disabled ? "disabled" : "ready"} ${credential.provider} ${credential.type} ${credential.credentialId}`,
	);
	return { exitCode: failed === 0 ? 0 : 1, stderr: "", stdout: `${lines.join("\n")}\n` };
}

async function serveCommand(
	command: ParsedCommand,
	options: AuthGatewayCommandOptions,
): Promise<AuthGatewayCommandExecution> {
	const broker = await requiredBrokerConfig(options);
	const store = brokerStore(broker);
	await store.metadataSnapshot();
	const bind = parseBind(command.bind ?? DEFAULT_BIND);
	const observability = createAuthGatewayObservabilityHandler({ broker: store, models: command.models });
	const handle = await startAuthGatewayTransport({
		auth: { kind: "token-file", path: gatewayTokenPath(agentDirectory(options)) },
		brokerUrl: broker.url,
		host: bind.host,
		onRequest: observability,
		port: bind.port,
		version: VERSION,
	});
	if (options.onGatewayStarted !== undefined) {
		try {
			await options.onGatewayStarted(handle);
		} finally {
			await handle.close();
		}
		return { exitCode: 0, stderr: "", stdout: "" };
	}
	process.stdout.write(`auth-gateway listening on ${handle.url}\n`);
	await waitForShutdown(handle);
	return { exitCode: 0, stderr: "", stdout: `auth-gateway stopped (${handle.url})\n` };
}

function statusResult(
	json: boolean,
	status: {
		readonly brokerConfigured: boolean;
		readonly credentialCount: number;
		readonly gatewayTokenPresent: boolean;
		readonly ready: boolean;
	},
): AuthGatewayCommandExecution {
	if (json) return { exitCode: status.ready ? 0 : 1, stderr: "", stdout: `${JSON.stringify(status)}\n` };
	const output = `broker: ${status.brokerConfigured ? "configured" : "missing"}\ncredentials: ${status.credentialCount}\ngateway token: ${status.gatewayTokenPresent ? "present" : "missing"}\n`;
	return { exitCode: status.ready ? 0 : 1, stderr: "", stdout: output };
}

function agentDirectory(options: AuthGatewayCommandOptions): string {
	return options.agentDir ?? getAgentDir();
}

async function brokerConfig(options: AuthGatewayCommandOptions, required: boolean): Promise<BrokerConfig | undefined> {
	const url = options.brokerUrl ?? process.env.SENPI_AUTH_BROKER_URL;
	if (url === undefined || url.length === 0) {
		if (!required) return undefined;
		throw new AuthGatewayCommandError(
			"auth-gateway requires broker authentication: set SENPI_AUTH_BROKER_URL and SENPI_AUTH_BROKER_TOKEN",
		);
	}
	const token =
		options.brokerToken ??
		process.env.SENPI_AUTH_BROKER_TOKEN ??
		(await readToken(join(agentDirectory(options), BROKER_TOKEN_FILE)));
	if (token === undefined) {
		throw new AuthGatewayCommandError(
			"auth-gateway requires broker authentication: set SENPI_AUTH_BROKER_TOKEN or auth-broker.token",
		);
	}
	return { token, url };
}

async function requiredBrokerConfig(options: AuthGatewayCommandOptions): Promise<BrokerConfig> {
	const broker = await brokerConfig(options, true);
	if (broker === undefined) throw new AuthGatewayCommandError("auth-gateway requires broker authentication");
	return broker;
}

async function snapshotFor(broker: BrokerConfig) {
	return brokerStore(broker).metadataSnapshot();
}

function brokerStore(broker: BrokerConfig): AuthBrokerRemoteStore {
	return new AuthBrokerRemoteStore({
		async request(request: unknown) {
			const response = await fetch(new URL("/v1/broker", broker.url), {
				body: JSON.stringify(request),
				headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" },
				method: "POST",
			});
			if (response.status === 401 || response.status === 403) {
				throw new AuthGatewayCommandError("Broker authentication failed.");
			}
			if (!response.ok) throw new AuthGatewayCommandError("Broker snapshot request failed.");
			return parseAuthBrokerWireResponse(await response.json());
		},
	});
}

function parseBind(value: string): { readonly host: string; readonly port: number } {
	const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(value);
	if (match === null)
		throw new AuthGatewayCommandError("Invalid gateway bind; use 127.0.0.1:PORT, [::1]:PORT, or localhost:PORT");
	const port = Number(match[2]);
	if (!Number.isInteger(port) || port < 0 || port > 65_535)
		throw new AuthGatewayCommandError("Invalid gateway bind port");
	const host = match[1] === "[::1]" ? "::1" : match[1];
	return { host, port };
}

function gatewayTokenPath(agentDir: string): string {
	return join(agentDir, GATEWAY_TOKEN_FILE);
}

async function gatewayToken(agentDir: string): Promise<string> {
	const path = gatewayTokenPath(agentDir);
	const current = await readToken(path);
	if (current !== undefined) return current;
	const handle = await startAuthGatewayTransport({ auth: { kind: "token-file", path }, port: 0 });
	try {
		const token = await readToken(path);
		if (token === undefined) throw new AuthGatewayCommandError("Unable to create gateway token safely");
		return token;
	} finally {
		await handle.close();
	}
}

async function replaceGatewayToken(agentDir: string): Promise<string> {
	const path = gatewayTokenPath(agentDir);
	await mkdir(agentDir, { mode: 0o700, recursive: true });
	await chmod(agentDir, 0o700);
	const token = randomBytes(32).toString("base64url");
	const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	await writeFile(temporary, `${token}\n`, { flag: "wx", mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, path);
	await chmod(path, 0o600);
	return token;
}

async function readToken(path: string): Promise<string | undefined> {
	try {
		const token = (await readFile(path, "utf8")).trim();
		return token.length === 0 ? undefined : token;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function waitForShutdown(handle: AuthGatewayTransportHandle): Promise<void> {
	await new Promise<void>((resolve) => {
		const shutdown = (): void => resolve();
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	}).finally(async () => {
		await handle.close();
	});
}
