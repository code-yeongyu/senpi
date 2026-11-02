import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
	CAPABILITIES,
	ENGINE_ORDINAL,
	maskServerIdentity,
	normalizedTrace,
	SERVER_VERSION,
} from "./4272-admission-golden-support.ts";

const protocolInfo = {
	type: "response",
	command: "get_protocol_info",
	success: true,
	data: {
		protocolVersion: 1,
		serverVersion: "2026.10.31-2",
		capabilities: ["multi_session", "event_resync"],
		engineVersion: "2026.10.31-2",
		engineOrdinal: [2026, 10, 31, 2],
	},
};

it("a recorded get_protocol_info frame normalizes its release identity instead of recursing", () => {
	expect(normalizedTrace([protocolInfo], tmpdir())).toEqual([
		{
			...protocolInfo,
			data: {
				protocolVersion: 1,
				serverVersion: SERVER_VERSION,
				capabilities: [CAPABILITIES],
				engineVersion: SERVER_VERSION,
				engineOrdinal: ENGINE_ORDINAL,
			},
		},
	]);
});

it("the byte mask labels the engine ordinal separately from the server version", () => {
	expect(maskServerIdentity(JSON.stringify(protocolInfo.data))).toBe(
		JSON.stringify({
			protocolVersion: 1,
			serverVersion: SERVER_VERSION,
			capabilities: [CAPABILITIES],
			engineVersion: SERVER_VERSION,
			engineOrdinal: ENGINE_ORDINAL,
		}),
	);
});
