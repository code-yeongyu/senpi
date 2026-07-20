import { getAgentDir, VERSION } from "../config.ts";
import type { AuthGatewayAuthorizedModel } from "../core/auth-gateway-observability.ts";
import {
	type AuthGatewayRequestRouterOptions,
	createAuthGatewayRequestRouter,
} from "../core/auth-gateway-request-router.ts";
import { type AuthGatewayTransportHandle, startAuthGatewayTransport } from "../core/auth-gateway-transport.ts";
import {
	AuthGatewayBrokerConfigError,
	brokerConfig,
	brokerStore,
	requiredBrokerConfig,
} from "./auth-gateway-broker-client.ts";
import { formatGatewayStatus } from "./auth-gateway-output.ts";
import { AuthGatewayParseError, parseAuthorizedModel, parseBind } from "./auth-gateway-parse.ts";
import { gatewayToken, gatewayTokenPath, readToken, replaceGatewayToken } from "./auth-gateway-token.ts";

const DEFAULT_BIND = "127.0.0.1:4000";

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
	readonly resolveModel?: AuthGatewayRequestRouterOptions["resolveModel"];
	readonly resolveRequest?: AuthGatewayRequestRouterOptions["resolveRequest"];
	readonly streamSimple?: AuthGatewayRequestRouterOptions["streamSimple"];
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
		const usageError =
			error instanceof AuthGatewayCommandError ||
			error instanceof AuthGatewayBrokerConfigError ||
			error instanceof AuthGatewayParseError;
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
	const broker = await brokerConfig(options, agentDir, false);
	if (broker === undefined) {
		return formatGatewayStatus(command.json, {
			brokerConfigured: false,
			credentialCount: 0,
			gatewayTokenPresent: tokenPresent,
			ready: false,
		});
	}
	const snapshot = await brokerStore(broker).metadataSnapshot();
	return formatGatewayStatus(command.json, {
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
	const broker = await requiredBrokerConfig(options, agentDirectory(options));
	const snapshot = await brokerStore(broker).metadataSnapshot();
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
			`${credential.disabled ? "disabled" : "configured"} ${credential.provider} ${credential.type} ${credential.credentialId}`,
	);
	return { exitCode: failed === 0 ? 0 : 1, stderr: "", stdout: `${lines.join("\n")}\n` };
}

async function serveCommand(
	command: ParsedCommand,
	options: AuthGatewayCommandOptions,
): Promise<AuthGatewayCommandExecution> {
	const broker = await requiredBrokerConfig(options, agentDirectory(options));
	const store = brokerStore(broker);
	await store.metadataSnapshot();
	const bind = parseBind(command.bind ?? DEFAULT_BIND);
	const router = createAuthGatewayRequestRouter({
		broker: store,
		models: command.models,
		resolveModel: options.resolveModel,
		resolveRequest: options.resolveRequest,
		streamSimple: options.streamSimple,
	});
	const handle = await startAuthGatewayTransport({
		auth: { kind: "token-file", path: gatewayTokenPath(agentDirectory(options)) },
		brokerUrl: broker.url,
		host: bind.host,
		onRequest: router.handle,
		port: bind.port,
		version: VERSION,
	});
	if (options.onGatewayStarted !== undefined) {
		try {
			await options.onGatewayStarted(handle);
		} finally {
			router.close();
			await handle.close();
		}
		return { exitCode: 0, stderr: "", stdout: "" };
	}
	process.stdout.write(`auth-gateway listening on ${handle.url}\n`);
	try {
		await waitForShutdown(handle);
	} finally {
		router.close();
	}
	return { exitCode: 0, stderr: "", stdout: `auth-gateway stopped (${handle.url})\n` };
}

function agentDirectory(options: AuthGatewayCommandOptions): string {
	return options.agentDir ?? getAgentDir();
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
