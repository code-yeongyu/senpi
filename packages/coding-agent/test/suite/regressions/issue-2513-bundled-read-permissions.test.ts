import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "../harness.ts";

// #2513: the user can read shipped resources, not arbitrary outside files or bundle writes.
let scratch: string;
let skillPath: string;
let harness: Harness | undefined;
const approvals: string[] = [];

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "senpi-bundle-read-"));
	const packageRoot = join(
		scratch,
		"OmO.app",
		"Contents",
		"Resources",
		"omo-runtime",
		`${process.platform}-${process.arch}`,
		"node_modules",
		"@code-yeongyu",
		"senpi",
	);
	skillPath = join(dirname(packageRoot), "senpi-codemode", "src", "skill", "bun-1-4", "SKILL.md");
	await mkdir(packageRoot, { recursive: true });
	await mkdir(dirname(skillPath), { recursive: true });
	await writeFile(join(dirname(packageRoot), "senpi-codemode", "package.json"), '{"name":"bundled-codemode"}');
	await writeFile(skillPath, "bundled skill instructions\n");
	vi.stubEnv("SENPI_PACKAGE_DIR", packageRoot);
	approvals.length = 0;
});

afterEach(async () => {
	harness?.cleanup();
	harness = undefined;
	vi.unstubAllEnvs();
	await rm(scratch, { recursive: true, force: true });
});

async function openSession(preset: string, rule?: string): Promise<Harness> {
	const flags = new Map([["permission-preset", preset]]);
	if (rule) flags.set("permission", rule);
	harness = await createHarness({
		extensionFactories: [permissionSystemExtension],
		extensionFlagValues: flags,
	});
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: createTestUiContext({
			select: async (title) => {
				approvals.push(title.split("\n")[0] ?? title);
				return "Deny";
			},
		}),
	});
	return harness;
}

describe("bundled resource reads through the session tool pipeline", () => {
	for (const spelling of ["file-url", "at-prefix", "quoted", "quoted-at-prefix"]) {
		it(`reads a shipped skill without asking using ${spelling}`, async () => {
			const session = await openSession("ask");
			const path =
				spelling === "file-url"
					? pathToFileURL(skillPath).href
					: spelling === "at-prefix"
						? `@${skillPath}`
						: spelling === "quoted"
							? `"${skillPath}"`
							: `@"${skillPath}"`;
			const result = await session.session.executeTool("read", { path });
			expect(approvals).toEqual([]);
			expect(getMessageText(result)).toContain("bundled skill instructions");
		});
	}

	for (const preset of ["accept-edits", "ask"]) {
		it(`honors an explicit deny for a shipped file in ${preset}`, async () => {
			const session = await openSession(preset, `read:${skillPath}=deny`);
			await expect(session.session.executeTool("read", { path: skillPath })).rejects.toThrow("specified a rule");
			expect(approvals).toEqual([]);
		});
	}

	it("honors a deny rule written for the original relative bundled path", async () => {
		const session = await openSession("ask", "read:../*=deny");
		const path = relative(session.tempDir, skillPath);
		await expect(session.session.executeTool("read", { path })).rejects.toThrow("specified a rule");
		expect(approvals).toEqual([]);
	});

	it("honors a deny on the resolved bundled file when it is read through a symlink alias", async () => {
		const link = join(dirname(skillPath), "alias.md");
		await symlink(skillPath, link);
		const session = await openSession("ask", "read:*SKILL.md=deny");
		await expect(session.session.executeTool("read", { path: link })).rejects.toThrow("specified a rule");
		expect(approvals).toEqual([]);
	});

	it("keeps the last explicit allow rule effective across supported bundled path spellings", async () => {
		const session = await openSession("ask", `read=deny,read:${skillPath}=allow`);
		const result = await session.session.executeTool("read", { path: pathToFileURL(skillPath).href });
		expect(getMessageText(result)).toContain("bundled skill instructions");
		expect(approvals).toEqual([]);
	});

	it("does not treat arbitrary development files in the engine package as shipped resources", async () => {
		const privatePath = fileURLToPath(new URL("../../../src/core/tools/read.ts", import.meta.url));
		const session = await openSession("accept-edits");
		await expect(session.session.executeTool("read", { path: privatePath })).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: external_directory"]);
	});

	it("asks when a bundled path traverses outside the shipped root", async () => {
		const outside = join(scratch, "private.txt");
		await writeFile(outside, "private outside content");
		const traversal = `${dirname(skillPath)}/${relative(dirname(skillPath), outside)}`;
		const session = await openSession("accept-edits");
		await expect(session.session.executeTool("read", { path: traversal })).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: external_directory"]);
	});

	it("keeps an outside file URL gated when the project itself is beneath a shipped root", async () => {
		const session = await openSession("accept-edits");
		vi.stubEnv("SENPI_PACKAGE_DIR", session.tempDir);
		await expect(session.session.executeTool("read", { path: pathToFileURL("/etc/hosts").href })).rejects.toThrow(
			"rejected permission",
		);
		expect(approvals).toEqual(["Permission required: external_directory"]);
	});

	for (const preset of ["full-access", "workspace", "accept-edits", "read-only", "ask"]) {
		it(`reads a packaged skill without asking when the preset is ${preset}`, async () => {
			// Given a packaged runtime outside the user's project.
			const session = await openSession(preset);
			// When the agent reads a shipped skill through the real read tool.
			const result = await session.session.executeTool("read", { path: skillPath });
			// Then its instructions reach the agent without an approval card.
			expect(approvals).toEqual([]);
			expect(getMessageText(result)).toContain("bundled skill instructions");
		});
	}

	it("asks for external_directory when accept-edits reads an outside system file", async () => {
		// Given a command-asking session.
		const session = await openSession("accept-edits");
		// When the agent reads a user-supplied outside path.
		const result = session.session.executeTool("read", { path: "/etc/hosts" });
		// Then denial prevents the system file reaching the agent.
		await expect(result).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: external_directory"]);
	});

	it("asks before writing a bundled file when the preset is ask", async () => {
		// Given a shipped file and an ask-first session.
		const session = await openSession("ask");
		// When the agent attempts to overwrite that file.
		const result = session.session.executeTool("write", { path: skillPath, content: "overwritten" });
		// Then the approval is required and denial leaves the shipped file intact.
		await expect(result).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: edit"]);
		expect(await readFile(skillPath, "utf8")).toBe("bundled skill instructions\n");
	});

	it("asks for an outside write even when accept-edits allows project edits", async () => {
		// Given a bundled file outside a project-editing session.
		const session = await openSession("accept-edits");
		// When the agent attempts to overwrite the bundled instructions.
		const result = session.session.executeTool("write", { path: skillPath, content: "overwritten" });
		// Then it still needs outside-directory approval.
		await expect(result).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: external_directory"]);
		expect(await readFile(skillPath, "utf8")).toBe("bundled skill instructions\n");
	});

	it("does not interpret a relative user path as relative to an install root", async () => {
		// Given a relative outside file beside the project, not in the bundle.
		const session = await openSession("accept-edits");
		const outside = join(scratch, "relative-outside.txt");
		await writeFile(outside, "outside");
		// When the agent reads it relative to the project.
		const result = session.session.executeTool("read", { path: relative(session.tempDir, outside) });
		// Then only the project-relative resolved target determines permission.
		await expect(result).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: external_directory"]);
	});

	it("asks when a bundled symlink resolves to an outside file", async () => {
		// Given a symlink in the bundle that escapes its shipped root.
		const outside = join(scratch, "private.txt");
		await writeFile(outside, "private outside content");
		const link = join(dirname(skillPath), "outside.md");
		await symlink(outside, link);
		const session = await openSession("accept-edits");
		// When the agent reads the apparent bundled file.
		const result = session.session.executeTool("read", { path: link });
		// Then the resolved outside path still requires approval and remains private.
		await expect(result).rejects.toThrow("rejected permission");
		expect(approvals).toEqual(["Permission required: external_directory"]);
	});
});
