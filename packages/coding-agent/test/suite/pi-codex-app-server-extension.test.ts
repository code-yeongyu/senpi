import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import {
	PI_CODEX_APP_SERVER_COMMAND,
	PI_CODEX_APP_SERVER_FLAG_ENABLED,
	PI_CODEX_APP_SERVER_FLAG_MODE,
	type PiCodexAppServerExtensionApi,
	registerPiCodexAppServerExtension,
} from "../../src/core/extensions/builtin/pi-codex-app-server/extension.ts";
import piCodexAppServerExtension from "../../src/core/extensions/builtin/pi-codex-app-server/index.ts";
import type {
	ExtensionAPI,
	ExtensionHandler,
	RegisteredCommand,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/core/extensions/types.ts";

type CommandRegistration = Omit<RegisteredCommand, "name" | "sourceInfo">;
type FlagRegistration = Parameters<ExtensionAPI["registerFlag"]>[1];
type LifecycleHandler = ExtensionHandler<SessionStartEvent> | ExtensionHandler<SessionShutdownEvent>;

interface PiCodexAppServerHarness {
	readonly commands: Map<string, CommandRegistration>;
	readonly flags: Map<string, FlagRegistration>;
	readonly handlers: Map<string, readonly LifecycleHandler[]>;
}

class HarnessApi implements PiCodexAppServerExtensionApi {
	readonly commands = new Map<string, CommandRegistration>();
	readonly flags = new Map<string, FlagRegistration>();
	readonly handlers = new Map<string, LifecycleHandler[]>();

	registerCommand(name: string, options: CommandRegistration): void {
		this.commands.set(name, options);
	}

	registerFlag(name: string, options: FlagRegistration): void {
		this.flags.set(name, options);
	}

	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_start" | "session_shutdown", handler: LifecycleHandler): void {
		const registered = this.handlers.get(event) ?? [];
		registered.push(handler);
		this.handlers.set(event, registered);
	}
}

function createHarness(): PiCodexAppServerHarness {
	const pi = new HarnessApi();
	registerPiCodexAppServerExtension(pi);
	return { commands: pi.commands, flags: pi.flags, handlers: pi.handlers };
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
		expect(handlers.get("session_start")).toHaveLength(1);
		expect(handlers.get("session_shutdown")).toHaveLength(1);
	});

	it("ships a harness shell that exposes help without starting runtime transport", () => {
		const harnessPath = join(
			process.cwd(),
			"src",
			"core",
			"extensions",
			"builtin",
			"pi-codex-app-server",
			"qa",
			"drive-adapter.mjs",
		);

		const result = spawnSync(process.execPath, [harnessPath, "--help"], {
			cwd: process.cwd(),
			encoding: "utf-8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("pi-codex-app-server adapter harness");
		expect(result.stdout).toContain("--external-stdio");
		expect(result.stdout).toContain("--app-server-url");
		expect(result.stderr).toBe("");
	});
});
