// senpi#6754 (ST): a hosted loop registers no tool, so its session tools run on the user's machine with the same tool
// code as locally. The session lives in the loop: each call carries the loop's session facts (session port, read) and
// returns the writes the loop commits (session port, write), at the real boundary of a brain's remote ToolHost and a
// hand's loopless runtimes over an in-process carrier.
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { TodoToolDetails } from "../../src/core/extensions/builtin/todotools/state.ts";
import { TODO_STATE_ENTRY_TYPE } from "../../src/core/extensions/builtin/todotools/todo-types.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { hostedLoop, textOf, userMachine } from "./hosted-session-fixture.ts";
import { cleanupHands, handDirs } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

/** An extension tool the session finds through tool search: deferred, activated on its first call unless `lazy: false`. */
const deferredTool =
	(name: string, options: { readonly lazy?: boolean } = {}) =>
	(pi: ExtensionAPI) =>
		pi.registerTool({
			name,
			label: name,
			description: `Draft the ${name.replaceAll("_", " ")} for a version.`,
			exposure: "search",
			...(options.lazy === false ? { allowLazyActivation: false } : {}),
			parameters: Type.Object({ version: Type.String() }),
			execute: async (_id, params) => ({
				content: [{ type: "text", text: `${name} for ${params.version}` }],
				details: {},
			}),
		});

describe("a hosted loop's session tools run on the user's machine through the session port (senpi#6754)", () => {
	it("todo returns its list, the loop commits its entry, and a later call carrying that entry sees the list", async () => {
		const dirs = await handDirs("st-todo");
		const { loop, port } = hostedLoop({ activeTools: ["read", "todo"] });
		const first = userMachine(dirs, port);

		const init = await first.call("t1", "todo", { op: "init", list: [{ phase: "Ship", items: ["tag the build"] }] });
		await first.close();
		// A fresh hand process: what it knows of the list is only what the loop carries.
		const second = userMachine(dirs, port);
		const view = await second.call("t2", "todo", { op: "view" });
		await second.close();

		expect(init.isError, textOf(init)).toBe(false);
		const details = init.details as TodoToolDetails;
		expect(details.phases.map((phase) => phase.name)).toEqual(["Ship"]);
		// The ask comes from the user's request the loop carried, as a local session reads it from its branch.
		expect(details.ask?.text).toBe("plan the release");
		expect(loop.committed.map(({ effects }) => effects.entries?.map((entry) => entry.customType))).toEqual([
			[TODO_STATE_ENTRY_TYPE],
			undefined,
		]);
		expect(view.isError, textOf(view)).toBe(false);
		expect((view.details as TodoToolDetails).phases).toEqual(details.phases);
		expect(textOf(view)).toContain("tag the build");
	}, 90_000);

	it("a deferred tool's first call activates it in the loop's tool set, and tool_search runs there", async () => {
		const dirs = await handDirs("st-search");
		const { loop, port } = hostedLoop({ activeTools: ["read"] });
		const machine = userMachine(dirs, port, [deferredTool("release_notes")]);

		const notes = await machine.call("n1", "release_notes", { version: "1.2.0" });
		const search = await machine.call("s1", "tool_search", { query: "draft release notes" });
		await machine.close();

		expect([notes.isError, textOf(notes)]).toEqual([false, "release_notes for 1.2.0"]);
		expect(loop.activeTools).toEqual(expect.arrayContaining(["read", "release_notes", "tool_search"]));
		expect(search.isError, textOf(search)).toBe(false);
		expect(textOf(search)).toContain("release_notes");
	}, 90_000);

	it("calls of one parallel batch each change the tool set they carried, and the loop keeps every change", async () => {
		const dirs = await handDirs("st-parallel");
		const { loop, port } = hostedLoop({ activeTools: ["read"] });
		const machine = userMachine(dirs, port, [deferredTool("alpha_notes"), deferredTool("beta_notes")]);

		// Both calls carry the same set ["read"]: neither sees the other's activation before it commits.
		const results = await machine.batch(
			[
				["a1", "alpha_notes", { version: "1" }],
				["b1", "beta_notes", { version: "2" }],
			],
			"parallel",
		);
		await machine.close();

		expect(results.map((result) => [result.isError, textOf(result)])).toEqual([
			[false, "alpha_notes for 1"],
			[false, "beta_notes for 2"],
		]);
		expect([...loop.activeTools].sort()).toEqual(["alpha_notes", "beta_notes", "read", "tool_search"]);
	}, 90_000);

	it("a tool the session cannot activate is refused on the hand, as the session refuses it, and never runs", async () => {
		const dirs = await handDirs("st-refused");
		const { loop, port } = hostedLoop({ activeTools: ["read"] });
		const machine = userMachine(dirs, port, [deferredTool("pinned_notes", { lazy: false })]);

		const refused = await machine.call("p1", "pinned_notes", { version: "1" });
		await machine.close();

		expect([refused.isError, textOf(refused)]).toEqual([true, "Tool pinned_notes not found"]);
		expect(loop.activeTools).not.toContain("pinned_notes");
	}, 90_000);
});
