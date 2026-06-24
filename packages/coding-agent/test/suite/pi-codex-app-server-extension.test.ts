import { describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import {
	PI_CODEX_APP_SERVER_COMMAND,
	PI_CODEX_APP_SERVER_FLAG_APP_SERVER_ARGS,
	PI_CODEX_APP_SERVER_FLAG_APP_SERVER_COMMAND,
	PI_CODEX_APP_SERVER_FLAG_ENABLED,
	PI_CODEX_APP_SERVER_FLAG_MODE,
	PI_CODEX_APP_SERVER_FLAG_TIMEOUT_MS,
	PI_CODEX_APP_SERVER_FLAG_UNIX_SOCKET,
	PI_CODEX_APP_SERVER_FLAG_URL,
	type PiCodexAppServerExtensionApi,
	registerPiCodexAppServerExtension,
} from "../../src/core/extensions/builtin/pi-codex-app-server/extension.ts";
import piCodexAppServerExtension from "../../src/core/extensions/builtin/pi-codex-app-server/index.ts";
import type {
	PiCodexAppServerRuntimeController,
	PiCodexAppServerRuntimeFlags,
} from "../../src/core/extensions/builtin/pi-codex-app-server/transport-runtime.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	RegisteredCommand,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/core/extensions/types.ts";

type CommandRegistration = Omit<RegisteredCommand, "name" | "sourceInfo">;
type FlagRegistration = Parameters<ExtensionAPI["registerFlag"]>[1];
interface RuntimeExtensionContext {
	readonly hasUI: boolean;
	readonly ui: Pick<ExtensionContext["ui"], "notify">;
}
type RuntimeLifecycleHandler<E> = (event: E, ctx: RuntimeExtensionContext) => Promise<void> | void;
type LifecycleHandler = RuntimeLifecycleHandler<SessionStartEvent> | RuntimeLifecycleHandler<SessionShutdownEvent>;

interface PiCodexAppServerHarness {
	readonly commands: Map<string, CommandRegistration>;
	readonly flags: Map<string, FlagRegistration>;
	readonly handlers: Map<string, readonly LifecycleHandler[]>;
	setFlag(name: string, value: boolean | string): void;
}

class HarnessApi implements PiCodexAppServerExtensionApi {
	readonly commands = new Map<string, CommandRegistration>();
	readonly flags = new Map<string, FlagRegistration>();
	readonly handlers = new Map<string, LifecycleHandler[]>();
	readonly flagValues = new Map<string, boolean | string>();

	registerCommand(name: string, options: CommandRegistration): void {
		this.commands.set(name, options);
	}

	registerFlag(name: string, options: FlagRegistration): void {
		this.flags.set(name, options);
		if (options.default !== undefined) {
			this.flagValues.set(name, options.default);
		}
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.flags.has(name)) return undefined;
		return this.flagValues.get(name);
	}

	on(event: "session_start", handler: RuntimeLifecycleHandler<SessionStartEvent>): void;
	on(event: "session_shutdown", handler: RuntimeLifecycleHandler<SessionShutdownEvent>): void;
	on(event: "session_start" | "session_shutdown", handler: LifecycleHandler): void {
		const registered = this.handlers.get(event) ?? [];
		registered.push(handler);
		this.handlers.set(event, registered);
	}
}

function createHarness(): PiCodexAppServerHarness {
	const pi = new HarnessApi();
	registerPiCodexAppServerExtension(pi);
	return {
		commands: pi.commands,
		flags: pi.flags,
		handlers: pi.handlers,
		setFlag(name: string, value: boolean | string) {
			pi.flagValues.set(name, value);
		},
	};
}

function createContext(): RuntimeExtensionContext {
	return {
		ui: {
			notify: () => undefined,
		},
		hasUI: true,
	};
}

describe("pi-codex-app-server extension skeleton", () => {
	it("registers exactly one builtin factory entry", () => {
		const entries = builtinExtensions.filter((extension) => extension.id === "pi-codex-app-server");

		expect(entries).toHaveLength(1);
		expect(entries[0]?.factory).toBe(piCodexAppServerExtension);
	});

	it("registers the command, flags, and lifecycle no-op handlers", () => {
		const { commands, flags, handlers } = createHarness();

		expect(commands.get(PI_CODEX_APP_SERVER_COMMAND)?.description).toContain("Codex app-server");
		expect(flags.get(PI_CODEX_APP_SERVER_FLAG_ENABLED)).toMatchObject({ type: "boolean", default: false });
		expect(flags.get(PI_CODEX_APP_SERVER_FLAG_MODE)).toMatchObject({ type: "string", default: "stdio" });
		expect(flags.get(PI_CODEX_APP_SERVER_FLAG_APP_SERVER_COMMAND)).toMatchObject({
			type: "string",
			default: "codex",
		});
		expect(flags.get(PI_CODEX_APP_SERVER_FLAG_APP_SERVER_ARGS)).toMatchObject({
			type: "string",
			default: "app-server",
		});
		expect(flags.get(PI_CODEX_APP_SERVER_FLAG_URL)).toMatchObject({ type: "string", default: "" });
		expect(flags.get(PI_CODEX_APP_SERVER_FLAG_UNIX_SOCKET)).toMatchObject({ type: "string", default: "" });
		expect(flags.get(PI_CODEX_APP_SERVER_FLAG_TIMEOUT_MS)).toMatchObject({ type: "string", default: "5000" });
		expect(handlers.get("session_start")).toHaveLength(1);
		expect(handlers.get("session_shutdown")).toHaveLength(1);
	});

	it("starts runtime only when enabled and stops it on session shutdown", async () => {
		const started: PiCodexAppServerRuntimeFlags[] = [];
		let stopCount = 0;
		const runtime: PiCodexAppServerRuntimeController = {
			getStatus: () => ({ kind: "stopped" }),
			start: async (flags) => {
				started.push(flags);
				return { kind: "running", mode: flags.mode };
			},
			stop: async () => {
				stopCount += 1;
				return { kind: "stopped" };
			},
		};
		const pi = new HarnessApi();
		registerPiCodexAppServerExtension(pi, () => runtime);
		pi.flagValues.set(PI_CODEX_APP_SERVER_FLAG_ENABLED, true);

		const startHandler = pi.handlers.get("session_start")?.[0] as RuntimeLifecycleHandler<SessionStartEvent>;
		const shutdownHandler = pi.handlers.get("session_shutdown")?.[0] as RuntimeLifecycleHandler<SessionShutdownEvent>;
		await startHandler({ type: "session_start", reason: "startup" }, createContext());
		await shutdownHandler({ type: "session_shutdown", reason: "quit" }, createContext());

		expect(started).toEqual([
			{
				enabled: true,
				mode: "stdio",
				appServerCommand: "codex",
				appServerArgs: ["app-server"],
				appServerUrl: "",
				appServerSocketPath: "",
				connectTimeoutMs: 5000,
			},
		]);
		expect(stopCount).toBe(1);
	});
});
