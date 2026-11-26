import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { createToolDispatcher } from "./tool-dispatcher.ts";

it("refuses a protected read before invoking the tool, but dispatches ordinary code and searches", async () => {
	const home = mkdtempSync(join(tmpdir(), "dispatch-home-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
	try {
		mkdirSync(join(home, ".omo"));
		const path = join(home, ".omo/device-identity.json");
		writeFileSync(path, "{}");
		symlinkSync(path, join(home, "notes"));
		const dispatcher = createToolDispatcher({ runtime: "in-process", cwd: home });
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		const run = (name: string, params: Record<string, string>) =>
			wrapToolDefinition(
				{ name, label: name, description: name, parameters: Type.Object({}), execute },
				undefined,
				dispatcher,
			).execute("id", params);
		for (const [name, params] of [
			["read", { path: "notes" }],
			["read", { path: "@notes" }],
			["bash", { command: 'cat "$HOME/.omo/device-identity.json"' }],
			["eval", { code: `await machine.shell("cat ~/.omo/device-identity.json")` }],
			["eval", { code: `fs.readFileSync("notes")` }],
		] as const) {
			await expect(run(name, params)).rejects.toThrow(`IDENTITY_FILE_REFUSED ${path}`);
		}
		expect(execute).not.toHaveBeenCalled();
		await expect(run("read", { path: "config/typevault/identity.json" })).rejects.toThrow(
			`IDENTITY_FILE_REFUSED ${join(home, "config/typevault/identity.json")}`,
		);
		await run("eval", { code: "rows.map(e => e.key)" });
		await run("grep", { pattern: path, path: "." });
		await run("read", { path: "docs/device-identity.json" });
		expect(execute).toHaveBeenCalledTimes(3);
	} finally {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	}
});

it("redacts identity-shaped JSON fields in final and update frames without dropping siblings", async () => {
	const token = "a".repeat(43);
	const listing = {
		Key: "photos/2024/image.jpg",
		key: token,
		uuid: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
		sha: "f".repeat(40),
	};
	const body = { signing: token, sealing: token, ek: token, sk: token, listing };
	const clean = { signing: "[REDACTED]", sealing: "[REDACTED]", ek: "[REDACTED]", sk: "[REDACTED]", listing };
	const ordinary = JSON.stringify(
		{ ...listing, signing: listing.sha, sealing: listing.uuid, key: listing.sha },
		null,
		2,
	);
	const definition: ToolDefinition = {
		name: "probe",
		label: "probe",
		description: "probe",
		parameters: Type.Object({}),
		execute: async (_id, _params, _signal, update) => {
			const result = {
				content: [
					{ type: "text", text: JSON.stringify(body) },
					{ type: "text", text: ordinary },
				] as const,
				details: { body },
			};
			const frame = { ...result, content: [...result.content] };
			update?.(frame);
			return frame;
		},
	};
	const tool = wrapToolDefinition(definition, undefined, createToolDispatcher({ runtime: "in-process" }));
	const onUpdate = vi.fn();
	const result = await tool.execute("id", {}, undefined, onUpdate);
	const expected = {
		content: [
			{ type: "text", text: JSON.stringify(clean) },
			{ type: "text", text: ordinary },
		],
		details: { body: clean },
	};
	expect(result).toEqual(expected);
	expect(onUpdate).toHaveBeenCalledWith(expected);
});
