import { readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createPermissionP0Host, type PermissionTurn } from "./permission-p0-host.ts";

// #2511: the host must deliver bookkeeping results without asking the user to approve them.
const bookkeeping = [
	"todo",
	"tool_search",
	"ask_user",
	"request_user_input",
	"ask_user_question",
	"memory",
	"monitor",
	"create_goal",
	"update_goal",
	"get_goal",
	"bash_output",
	"bash_resize",
	"kill_bash",
];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

// External harnesses supply some of these tools. Their implementations return a receipt;
// the real CLI host, tool dispatch, permission parsers, rules and UI bridge remain in use.
const tools: ExtensionFactory = (pi) => {
	for (const name of [...bookkeeping.filter((name) => name !== "tool_search"), "catalog_probe"]) {
		pi.registerTool({
			name,
			label: name,
			description: "Return a harness operation receipt.",
			exposure: name === "catalog_probe" ? "search" : "direct",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: `completed ${name}` }], details: {} };
			},
		});
	}
};

describe("internal tools in real host sessions", () => {
	for (const preset of ["full-access", "accept-edits", "ask"]) {
		for (const name of bookkeeping) {
			it(`runs ${name} without an approval when the preset is ${preset}`, async () => {
				// Given a host with the requested per-session preset.
				const host = await createPermissionP0Host([tools]);
				disposers.push(host.dispose);
				// When the provider requests a harness operation.
				const args: PermissionTurn["args"] =
					name === "tool_search" ? { query: "catalog_probe" } : name === "monitor" ? { action: "rearm" } : {};
				const result = await host.run(preset, { name, args });
				// Then the client receives its result without an approval card.
				expect(result.approvals).toEqual([]);
				expect(JSON.stringify(result.result)).toContain(
					name === "tool_search" ? "catalog_probe" : `completed ${name}`,
				);
			});
		}
	}

	for (const preset of ["accept-edits", "ask"]) {
		for (const name of ["eval", "bash", "project_deploy"]) {
			it(`still asks for ${name} when the preset is ${preset}`, async () => {
				// Given the same host, including an unrelated extension tool.
				const commandTool: ExtensionFactory = (pi) =>
					pi.registerTool({
						name,
						label: name,
						description: "Return a command receipt.",
						parameters: Type.Object({}),
						async execute() {
							return { content: [{ type: "text", text: "command executed" }], details: {} };
						},
					});
				const host = await createPermissionP0Host([tools, commandTool]);
				disposers.push(host.dispose);
				// When the provider requests an action and the client denies its approval.
				const result = await host.run(preset, { name, args: {} });
				// Then execution is prevented, rather than accidentally exempted.
				expect(result.approvals).toHaveLength(1);
				expect(JSON.stringify(result.result)).not.toContain("command executed");
			});
		}
	}

	for (const preset of ["accept-edits", "ask"]) {
		it(`asks before an outside path monitor when the preset is ${preset}`, async () => {
			// Given the native monitor, which reads file bytes to detect content changes.
			const host = await createPermissionP0Host([], undefined, ["terminal"]);
			disposers.push(host.dispose);
			// When the provider requests an outside file and the client denies it.
			const result = await host.run(preset, {
				name: "monitor",
				args: { description: "Outside file", path: host.outsidePath, event: "modify" },
			});
			// Then no outside-file monitor is registered.
			expect(result.approvals).toHaveLength(1);
			expect(result.isError).toBe(true);
		});

		it(`asks before a monitor command when the preset is ${preset}`, async () => {
			// Given a monitor that can execute a command.
			const host = await createPermissionP0Host([tools]);
			disposers.push(host.dispose);
			// When the provider requests a command subscription and the client denies it.
			const result = await host.run(preset, { name: "monitor", args: { command: "printf command-ran" } });
			// Then the command takes the same approval path as bash.
			expect(result.approvals).toHaveLength(1);
			expect(result.approvals[0]?.title?.split("\n")[0]).toBe("Permission required: bash");
			expect(JSON.stringify(result.result)).not.toContain("completed monitor");
		});
	}

	it("honors an internal tool's explicit outside-file permission", async () => {
		// Given an extension action that is not confined to harness state.
		const externalMemory: ExtensionFactory = (pi) =>
			pi.registerTool({
				name: "memory",
				label: "Memory export",
				description: "Export state to a user file.",
				parameters: Type.Object({ path: Type.String() }),
				permissionParser: () => [{ permission: "external_directory", patterns: ["*"], always: ["*"] }],
				async execute(_id, args) {
					await writeFile(args.path, "exported state");
					return { content: [{ type: "text", text: "export complete" }], details: {} };
				},
			});
		const host = await createPermissionP0Host([externalMemory]);
		disposers.push(host.dispose);
		// When the user denies the outside-file action.
		const result = await host.run("accept-edits", { name: "memory", args: { path: host.outsidePath } });
		// Then the existing outside file is untouched.
		expect(result.approvals).toHaveLength(1);
		expect(await readFile(host.outsidePath, "utf8")).toBe("private outside content\n");
	});

	it("keeps bookkeeping available even when a user rule denies tool names", async () => {
		// Given a deny rule that used to remove the todo tool at session startup.
		const host = await createPermissionP0Host([tools], "todo=deny");
		disposers.push(host.dispose);
		// When the provider requests bookkeeping.
		const result = await host.run("ask", { name: "todo", args: {} });
		// Then the operation is still callable and completes without approval.
		expect(result.activeTools).toContain("todo");
		expect(result.approvals).toEqual([]);
		expect(JSON.stringify(result.result)).toContain("completed todo");
	});

	it("still asks before reading an outside file in accept-edits", async () => {
		// Given a real file outside the project.
		const host = await createPermissionP0Host([tools]);
		disposers.push(host.dispose);
		// When the provider requests it and the client denies.
		const result = await host.run("accept-edits", { name: "read", args: { path: host.outsidePath } });
		// Then its private contents never reach the model.
		expect(result.approvals).toHaveLength(1);
		expect(JSON.stringify(result.result)).not.toContain("private outside content");
	});
});
