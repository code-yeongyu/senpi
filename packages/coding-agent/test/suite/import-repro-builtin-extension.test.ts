import { describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../src/core/extensions/types.ts";

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

interface FactoryProbe {
	readonly commands: Set<string>;
	readonly handlers: Map<string, CommandHandler>;
}

function runFactory(factory: ExtensionFactory): FactoryProbe {
	const probe: FactoryProbe = { commands: new Set(), handlers: new Map() };
	const pi = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "registerCommand") {
					return (name: string, spec?: { handler?: CommandHandler }) => {
						probe.commands.add(name);
						if (spec?.handler) probe.handlers.set(name, spec.handler);
					};
				}
				return () => undefined;
			},
		},
	) as unknown as ExtensionAPI;
	factory(pi);
	return probe;
}

function importReproFactory(): ExtensionFactory {
	const entry = builtinExtensions.find((extension) => extension.id === "import-repro");
	if (entry === undefined) {
		throw new Error("missing import-repro builtin extension");
	}
	return entry.factory;
}

interface Notification {
	readonly message: string;
	readonly severity?: string;
}

/** Minimal command ctx: idle/compacting knobs, a notify sink, and a switchSession tripwire. */
function busyCtx(options: {
	idle: boolean;
	compacting: boolean;
	notifications: Notification[];
}): ExtensionCommandContext {
	return {
		isIdle: () => options.idle,
		isCompacting: () => options.compacting,
		ui: {
			notify: (message: string, severity?: string) => {
				options.notifications.push({ message, severity });
			},
		},
		switchSession: () => {
			throw new Error("switchSession must not run while the agent is busy");
		},
	} as unknown as ExtensionCommandContext;
}

describe("import-repro builtin extension", () => {
	it("registers the /ir command", () => {
		const probe = runFactory(importReproFactory());

		expect(probe.commands.has("ir")).toBe(true);
	});

	it("warns and returns without importing when the session is not idle", async () => {
		const probe = runFactory(importReproFactory());
		const handler = probe.handlers.get("ir");
		if (handler === undefined) throw new Error("missing /ir handler");
		const notifications: Notification[] = [];

		await handler("", busyCtx({ idle: false, compacting: false, notifications }));

		expect(notifications).toEqual([
			{ message: "/ir is unavailable while the agent is working", severity: "warning" },
		]);
	});

	it("warns and returns without importing while compaction is running", async () => {
		const probe = runFactory(importReproFactory());
		const handler = probe.handlers.get("ir");
		if (handler === undefined) throw new Error("missing /ir handler");
		const notifications: Notification[] = [];

		await handler("", busyCtx({ idle: true, compacting: true, notifications }));

		expect(notifications).toEqual([
			{ message: "/ir is unavailable while the agent is working", severity: "warning" },
		]);
	});

	it("still runs when the session is idle and not compacting", async () => {
		const probe = runFactory(importReproFactory());
		const handler = probe.handlers.get("ir");
		if (handler === undefined) throw new Error("missing /ir handler");
		const notifications: Notification[] = [];

		await handler("", busyCtx({ idle: true, compacting: false, notifications }));

		expect(notifications).toEqual([
			{ message: "Usage: /ir <gist-id | gist-url | pi.dev/session URL | issue URL>", severity: "error" },
		]);
	});
});
