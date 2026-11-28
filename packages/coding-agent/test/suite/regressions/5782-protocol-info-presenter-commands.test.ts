import { describe, expect, it } from "vitest";
import type { ControlAttachments } from "../../../src/modes/interactive/session-control-attach.ts";
import {
	type ControlCommandContext,
	runControlCommand,
} from "../../../src/modes/interactive/session-control-commands.ts";
import type { ControlConnection } from "../../../src/modes/interactive/session-control-server.ts";
import { TERMINAL_PRESENTER_COMMANDS } from "../../../src/modes/interactive/terminal-presenter-surface.ts";

// #5782: a terminal control endpoint advertised the MCP presenter frames in get_protocol_info even when
// it had no presenter surface, so a client that trusted the list got `unsupported`. get_protocol_info
// reads only the instance id and the attachments' presenter surface, so both endpoint shapes are
// table rows here.

const connection = { id: 1, send() {}, transport: {} } as unknown as ControlConnection;

async function advertisedCommands(presenters: ControlAttachments["presenters"]): Promise<readonly string[]> {
	const context = {
		instanceId: "t-0000000000000000",
		attachments: { presenters },
	} as unknown as ControlCommandContext;
	const reply = (await runControlCommand(context, connection, { type: "get_protocol_info", id: "1" })) as {
		readonly data: { readonly commands: readonly string[] };
	};
	return reply.data.commands;
}

describe("#5782 get_protocol_info advertises presenter frames only when the endpoint serves them", () => {
	const surface = {} as NonNullable<ControlAttachments["presenters"]>;

	it.each([
		{ shape: "without a presenter surface", presenters: undefined, advertised: false },
		{ shape: "with a presenter surface", presenters: surface, advertised: true },
	])("$shape", async ({ presenters, advertised }) => {
		const commands = await advertisedCommands(presenters);

		for (const frame of TERMINAL_PRESENTER_COMMANDS) expect(commands.includes(frame)).toBe(advertised);
		expect(commands).toContain("get_protocol_info");
		expect(commands).toContain("open_session");
	});

	it("leaves every other command unchanged", async () => {
		const without = await advertisedCommands(undefined);
		const withSurface = await advertisedCommands(surface);
		const presenterFrames = new Set<string>(TERMINAL_PRESENTER_COMMANDS);

		expect(withSurface.filter((command) => !presenterFrames.has(command))).toEqual(without);
	});
});
