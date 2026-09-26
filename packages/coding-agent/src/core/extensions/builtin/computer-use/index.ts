import { type ChildFactory, engineChildFactory } from "@code-yeongyu/senpi-desktop-service";
import {
	COMPUTER_ACTIONS_TOOL_NAME,
	COMPUTER_COMMAND_USAGE,
	COMPUTER_SUBCOMMANDS,
	COMPUTER_TOOL_NAME,
	ComputerHandle,
	computerActionsPermissionParser,
	computerPermissionParser,
	createComputerActionsTool,
	createComputerTool,
	isSupportedHost,
	materializeComputerSkill,
	runComputerCommand,
} from "@code-yeongyu/senpi-desktop-tool";
import type { ExtensionAPI, ExtensionFactory } from "../../types.ts";
import { registerToolParser } from "../permission-system/parsers.ts";
import { TrackedDesktopService } from "./engine-status.ts";
import { loadComputerSettings } from "./settings.ts";

/** oh-my-pi's wording for a session without computer use (unsupported host or `computer.enabled: false`). */
export const COMPUTER_UNAVAILABLE = "Computer use is unavailable in this session.";

export interface ComputerUseDeps {
	readonly platform: string;
	/** Starts the engine child; `enginePath` is the `computer.enginePath` override (`undefined`: the located binary). */
	readonly engineChild: (enginePath: string | undefined) => ChildFactory;
}

interface ComputerSession {
	readonly handle: ComputerHandle;
	readonly service: TrackedDesktopService;
}

function isStatus(args: string): boolean {
	return (args.trim().toLowerCase() || "status") === "status";
}

/**
 * The `computer` tool, its permission parser, and `/computer`. The tool is registered search-exposed on
 * session_start (supported host and `computer.enabled`) and nothing starts until it is activated: a
 * tool_search by-name call, `pi.setActiveTools`, or `/computer on`. Activation opens the engine session and
 * arms the stop chord; codemode installs the `computer` global from the tool's `kernelPrelude` for the next
 * eval cell once the tool is active. `/computer stop|resume` is user-only: over rpc it arrives as a `prompt`
 * that `AgentSession.prompt` dispatches to the command, a path no tool call can reach.
 */
export function createComputerUseExtension(deps: ComputerUseDeps): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let session: ComputerSession | undefined;

		const syncActiveTools = (active: boolean) => {
			const current = pi.getActiveTools();
			if (active === current.includes(COMPUTER_TOOL_NAME)) return;
			pi.setActiveTools(
				active ? [...current, COMPUTER_TOOL_NAME] : current.filter((name) => name !== COMPUTER_TOOL_NAME),
			);
		};

		const closeSession = async () => {
			const closing = session;
			session = undefined;
			await closing?.handle.close();
		};

		pi.registerCommand("computer", {
			description: "Computer use: on, off, status, stop, or resume (stop and resume are user-only)",
			argumentHint: COMPUTER_SUBCOMMANDS.join("|"),
			getArgumentCompletions: (prefix) =>
				COMPUTER_SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({
					value: name,
					label: name,
				})),
			handler: async (args, ctx) => {
				if (session === undefined) {
					ctx.ui.notify(COMPUTER_UNAVAILABLE, "warning");
					return;
				}
				const { handle, service } = session;
				try {
					const text = await runComputerCommand(args, handle, ctx);
					if (!isStatus(args)) {
						ctx.ui.notify(text, text === COMPUTER_COMMAND_USAGE ? "warning" : "info");
						return;
					}
					const prelude = pi.getActiveTools().includes(COMPUTER_TOOL_NAME) ? "active" : "inactive";
					ctx.ui.notify(`${text}\nengine: ${service.engineState}\nprelude: ${prelude}`, "info");
				} catch (error) {
					if (!(error instanceof Error)) throw error;
					ctx.ui.notify(`/computer ${args.trim()}: ${error.message}`, "error");
				}
			},
		});

		pi.on("session_start", async (_event, ctx) => {
			await closeSession();
			if (!isSupportedHost(deps.platform)) return;
			const settings = loadComputerSettings(ctx, deps.platform);
			if (!settings.enabled) return;
			const service = new TrackedDesktopService({ createChild: deps.engineChild(settings.enginePath) });
			const handle = new ComputerHandle({ service, settings: () => settings });
			handle.onActivationChange(syncActiveTools);
			// todo 24(b): the permission-system tool_call hook is the only place the tier is evaluated.
			registerToolParser(COMPUTER_TOOL_NAME, computerPermissionParser);
			const executeTool = (toolName: string, params: unknown, options: { readonly signal: AbortSignal }) =>
				pi.executeTool(toolName, params, options);
			pi.registerTool(createComputerTool({ handle, executeTool }));
			if (settings.cuaAdapter) {
				registerToolParser(COMPUTER_ACTIONS_TOOL_NAME, computerActionsPermissionParser);
				pi.registerTool(createComputerActionsTool({ handle, executeTool }));
			}
			session = { handle, service };
		});

		// resources_discover fires after session_start, so the skill tracks the same host and setting gate as the tool.
		pi.on("resources_discover", () =>
			session === undefined ? undefined : { skillPaths: [materializeComputerSkill()] },
		);

		pi.on("tool_activated", async (event, ctx) => {
			if (session === undefined || session.handle.active || !event.toolNames.includes(COMPUTER_TOOL_NAME)) return;
			await session.handle.activate(ctx);
		});

		pi.on("session_shutdown", closeSession);
	};
}

export default function computerUseExtension(pi: ExtensionAPI): void {
	createComputerUseExtension({ platform: process.platform, engineChild: engineChildFactory })(pi);
}
