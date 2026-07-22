import { arch, platform, release, type } from "node:os";
import type { ClientInfo, InitializeCapabilities, InitializeParams, InitializeResponse } from "../protocol/index.ts";
import { EXPERIMENTAL_SERVER_NOTIFICATION_METHODS, SERVER_NOTIFICATION_METHODS } from "../protocol/methods.ts";
import { populateOutboundNotificationEnvelope, type RpcEnvelope, type RpcNotification } from "../rpc/envelope.ts";
import type { RegistryConnection, ConnectionCapabilities as RegistryConnectionCapabilities } from "../rpc/registry.ts";

export type ConnectionId = string;
export type TransportKind = "stdio" | "websocket" | "unix";
export type ConnectionCapabilities = InitializeCapabilities;

export interface InitializedState {
	readonly initialized: true;
	readonly clientInfo: ClientInfo;
	readonly capabilities: ConnectionCapabilities;
	readonly userAgent: string;
}

export type InitializeStateChange = { readonly kind: "initialized" } | { readonly kind: "already-initialized" };

export interface Connection extends RegistryConnection {
	readonly id: ConnectionId;
	readonly transportKind: TransportKind;
	readonly initializedState: InitializedState | undefined;
	readonly capabilities: ConnectionCapabilities;
	readonly optOutNotificationMethods: Set<string>;
	initialize(params: InitializeParams, serverVersion: string): InitializeStateChange;
	send(message: RpcEnvelope): Promise<void>;
	close(reason: string): Promise<void>;
}

export interface ConnectionInput {
	readonly id: ConnectionId;
	readonly transportKind: TransportKind;
	readonly send: (message: RpcEnvelope) => Promise<void> | void;
	readonly close: (reason: string) => Promise<void> | void;
}

type UninitializedState = {
	readonly initialized: false;
};

type ConnectionState = UninitializedState | InitializedState;

type JsonObject = {
	readonly [key: string]: unknown;
};

const DEFAULT_CAPABILITIES: ConnectionCapabilities = {
	experimentalApi: false,
	requestAttestation: false,
};

const SERVER_NOTIFICATIONS = new Set<string>(SERVER_NOTIFICATION_METHODS);
const EXPERIMENTAL_SERVER_NOTIFICATIONS = new Set<string>(EXPERIMENTAL_SERVER_NOTIFICATION_METHODS);

export class ManagedConnection implements Connection {
	readonly id: ConnectionId;
	readonly transportKind: TransportKind;
	readonly optOutNotificationMethods = new Set<string>();
	private state: ConnectionState = { initialized: false };
	private readonly sendMessage: (message: RpcEnvelope) => Promise<void> | void;
	private readonly closeConnection: (reason: string) => Promise<void> | void;

	constructor(input: ConnectionInput) {
		this.id = input.id;
		this.transportKind = input.transportKind;
		this.sendMessage = input.send;
		this.closeConnection = input.close;
	}

	get initialized(): boolean {
		return this.state.initialized;
	}

	get initializedState(): InitializedState | undefined {
		return this.state.initialized ? this.state : undefined;
	}

	get capabilities(): ConnectionCapabilities & RegistryConnectionCapabilities {
		return this.state.initialized ? this.state.capabilities : DEFAULT_CAPABILITIES;
	}

	initialize(params: InitializeParams, serverVersion: string): InitializeStateChange {
		if (this.state.initialized) {
			return { kind: "already-initialized" };
		}

		const capabilities = normalizeCapabilities(params.capabilities);
		this.optOutNotificationMethods.clear();
		for (const method of capabilities.optOutNotificationMethods ?? []) {
			this.optOutNotificationMethods.add(method);
		}

		const userAgent = buildUserAgent(params.clientInfo.name, serverVersion);
		this.state = {
			initialized: true,
			clientInfo: params.clientInfo,
			capabilities,
			userAgent,
		};
		return { kind: "initialized" };
	}

	async send(message: RpcEnvelope): Promise<void> {
		await this.sendMessage(populateOutboundNotificationEnvelope(message));
	}

	async close(reason: string): Promise<void> {
		await this.closeConnection(reason);
	}
}

export function createConnection(input: ConnectionInput): Connection {
	return new ManagedConnection(input);
}

export function parseInitializeParams(params: unknown): InitializeParams | null {
	if (!isJsonObject(params)) {
		return null;
	}
	const clientInfo = parseClientInfo(params.clientInfo);
	if (!clientInfo) {
		return null;
	}

	const capabilities = parseCapabilities(params.capabilities);
	if (capabilities === "invalid") {
		return null;
	}
	return { clientInfo, capabilities };
}

export function canDeliverNotification(connection: Connection, notification: RpcNotification): boolean {
	if (!connection.initialized) {
		return false;
	}
	if (!SERVER_NOTIFICATIONS.has(notification.method)) {
		return false;
	}
	if (connection.optOutNotificationMethods.has(notification.method)) {
		return false;
	}
	return !EXPERIMENTAL_SERVER_NOTIFICATIONS.has(notification.method) || connection.capabilities.experimentalApi;
}

export function buildInitializeResponse(connection: Connection, codexHome: string): InitializeResponse {
	const state = connection.initializedState;
	if (!state) {
		throw new Error("Connection is not initialized");
	}
	return {
		userAgent: state.userAgent,
		codexHome,
		platformFamily: platformFamily(),
		platformOs: platformOs(),
	};
}

function parseClientInfo(value: unknown): ClientInfo | null {
	if (!isJsonObject(value)) {
		return null;
	}
	const name = value.name;
	const version = value.version;
	const title = value.title;
	if (typeof name !== "string" || name.length === 0 || typeof version !== "string" || version.length === 0) {
		return null;
	}
	if (title !== undefined && title !== null && typeof title !== "string") {
		return null;
	}
	return { name, title: typeof title === "string" ? title : null, version };
}

function parseCapabilities(value: unknown): InitializeCapabilities | "invalid" | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (!isJsonObject(value)) {
		return "invalid";
	}

	const experimentalApi = parseOptionalBoolean(value.experimentalApi);
	const requestAttestation = parseOptionalBoolean(value.requestAttestation);
	const mcpServerOpenaiFormElicitation = parseOptionalBoolean(value.mcpServerOpenaiFormElicitation);
	const optOutNotificationMethods = parseOptionalStringArray(value.optOutNotificationMethods);
	if (
		experimentalApi === "invalid" ||
		requestAttestation === "invalid" ||
		mcpServerOpenaiFormElicitation === "invalid" ||
		optOutNotificationMethods === "invalid"
	) {
		return "invalid";
	}

	return {
		experimentalApi: experimentalApi ?? false,
		requestAttestation: requestAttestation ?? false,
		...(mcpServerOpenaiFormElicitation === undefined ? {} : { mcpServerOpenaiFormElicitation }),
		...(optOutNotificationMethods === null ? {} : { optOutNotificationMethods }),
	};
}

function normalizeCapabilities(capabilities: InitializeCapabilities | null): ConnectionCapabilities {
	return capabilities ?? DEFAULT_CAPABILITIES;
}

function parseOptionalBoolean(value: unknown): boolean | "invalid" | undefined {
	if (value === undefined) {
		return undefined;
	}
	return typeof value === "boolean" ? value : "invalid";
}

function parseOptionalStringArray(value: unknown): readonly string[] | "invalid" | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		return "invalid";
	}
	return value;
}

function buildUserAgent(clientName: string, serverVersion: string): string {
	return `${clientName}/${serverVersion} (${type()} ${release()}; ${arch()}) senpi_app_server`;
}

function platformFamily(): "unix" | "windows" {
	return platform() === "win32" ? "windows" : "unix";
}

function platformOs(): "macos" | "linux" | "windows" {
	switch (platform()) {
		case "darwin":
			return "macos";
		case "win32":
			return "windows";
		default:
			return "linux";
	}
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
