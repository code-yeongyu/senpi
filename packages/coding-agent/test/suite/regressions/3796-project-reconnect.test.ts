// #3796: reconnect through the real service must not invalidate its own project policy.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { createMcpExtension } from "../../../src/core/extensions/builtin/mcp/index.ts";
import {
	getProjectMcpAuthority,
	type ProjectMcpAuthority,
} from "../../../src/core/extensions/builtin/mcp/project-skill-policy.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { stdioServer } from "../../mcp/fixtures/service-lifecycle.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

const roots: string[] = [];
const services: McpService[] = [];
const harnesses: Harness[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const service of services.splice(0)) await service.dispose("quit");
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
	const root = mkdtempSync(join(tmpdir(), "senpi-3796-command-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const skillDir = join(root, ".senpi", "skills", "project-probe");
	const userSkillDir = join(agentDir, "skills", "user-probe");
	mkdirSync(agentDir);
	mkdirSync(skillDir, { recursive: true });
	mkdirSync(userSkillDir, { recursive: true });
	mkdirSync(join(root, ".git"));
	vi.stubEnv("HOME", root);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	const skillPath = join(skillDir, "SKILL.md");
	writeFileSync(skillPath, "---\nname: project-probe\ndescription: synthetic\n---\nprobe\n");
	writeFileSync(
		join(skillDir, "mcp.json"),
		JSON.stringify({ mcpServers: { "project-envprobe": stdioServer(["--tools", "1"]) } }),
	);
	const userSkillPath = join(userSkillDir, "SKILL.md");
	writeFileSync(userSkillPath, "---\nname: user-probe\ndescription: synthetic\n---\nprobe\n");
	writeFileSync(
		join(userSkillDir, "mcp.json"),
		JSON.stringify({ mcpServers: { "user-envprobe": stdioServer(["--tools", "1"]) } }),
	);
	const service = new McpService();
	services.push(service);
	const extensionsResult = await createTestExtensionsResult([createMcpExtension(service)]);
	const loader = createTestResourceLoader({ extensionsResult });
	const harness = await createHarness({
		cwd: root,
		resourceLoader: {
			...loader,
			getSkills: () => ({
				skills: [
					{
						name: "project-probe",
						description: "synthetic",
						filePath: skillPath,
						baseDir: skillDir,
						source: "project",
						sourceInfo: { scope: "project", path: skillPath, source: "local", origin: "top-level" },
						disableModelInvocation: false,
					},
					{
						name: "user-probe",
						description: "synthetic",
						filePath: userSkillPath,
						baseDir: userSkillDir,
						source: "user",
						sourceInfo: { scope: "user", path: userSkillPath, source: "local", origin: "top-level" },
						disableModelInvocation: false,
					},
				],
				diagnostics: [],
			}),
		},
	});
	harnesses.push(harness);
	const notices: string[] = [];
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	await harness.session.bindExtensions({
		mode: "rpc",
		uiContext: createTestUiContext({ notify: (text) => notices.push(text) }),
	});
	harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
	await harness.session.prompt("/skill:user-probe");
	await harness.session.prompt("/skill:project-probe");
	expect(await service.whenAttachSettled(10_000)).toBe("settled");
	const connection = service.getConnection("project-envprobe");
	if (connection === undefined) throw new Error("missing project skill connection");
	await connection.connect();
	expect(existsSync(join(agentDir, "mcp-env-grants.json"))).toBe(false);
	await vi.advanceTimersByTimeAsync(6_000);
	const config = service.getAuthTarget("project-envprobe")?.config;
	const policy = config === undefined ? undefined : getProjectMcpAuthority(config);
	if (policy === undefined) throw new Error("missing project policy");
	return { service, harness, connection, policy, notices };
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("MCP lifecycle signal did not arrive")), 10_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function writeGrantFromAnotherProcess(policy: ProjectMcpAuthority, grant: boolean): Promise<void> {
	const store = new URL("../../../src/core/extensions/builtin/mcp/env-grants-store.ts", import.meta.url).href;
	const script = [
		`const {addGrant,revoke} = await import(${JSON.stringify(store)});`,
		grant
			? `await addGrant(process.argv[1],process.argv[2],{project:"synthetic",skill:"project-probe",server:"project-envprobe"},["ODD_DSN"]);`
			: `await revoke(process.argv[1],process.argv[2]);`,
	].join("");
	await execFileAsync(process.execPath, ["--input-type=module", "-e", script, policy.storePath, policy.identity], {
		timeout: 10_000,
	});
}

it("keeps a project reconnect alive when a user skill reconnect finishes first", async () => {
	// Given: both skills have run in one trusted RPC session with no grant file.
	const { service, harness, connection, policy, notices } = await setup();
	const resolving = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const resolve = policy.resolve.bind(policy);
	vi.spyOn(policy, "resolve").mockImplementationOnce(async (...args) => {
		resolving.resolve();
		await release.promise;
		return resolve(...args);
	});
	// When: subscribe before issuing both commands. Hold only policy IO so the user
	// reconnect's completion/reload deterministically races project materialization.
	const userReconnect = harness.session.prompt("/mcp reconnect user-envprobe");
	const projectReconnect = harness.session.prompt("/mcp reconnect project-envprobe");
	try {
		await bounded(resolving.promise);
		await bounded(userReconnect);
	} finally {
		release.resolve();
	}
	await bounded(projectReconnect);
	// Then: both commands succeed, and the project server remains usable.
	expect(notices).toEqual(["MCP reconnect user-envprobe connected", "MCP reconnect project-envprobe connected"]);
	expect(service.getConnection("project-envprobe")).toBe(connection);
	expect(connection.state).toBe("connected");
	expect((await connection.client.listTools()).tools).toHaveLength(1);
});

it.each(["live", "pending"] as const)("honors cross-process revocation after reattach (%s)", async (phase) => {
	// Given: a skill registration retained by an administrative reconnect.
	const { service, harness, connection, policy } = await setup();
	await harness.session.prompt("/mcp reconnect user-envprobe");
	const changed = Promise.withResolvers<void>();
	const off = connection.onStateChange((event) => {
		if (event.state === "idle") changed.resolve();
	});
	try {
		await writeGrantFromAnotherProcess(policy, true);
		await bounded(changed.promise);
	} finally {
		off();
	}
	await connection.connect();
	expect(connection.startedGrantNames).toEqual(["ODD_DSN"]);

	// When: another process revokes the grant, either live or during policy IO.
	if (phase === "live") {
		const closed = Promise.withResolvers<void>();
		const client = connection.client;
		const onclose = client.onclose;
		client.onclose = () => {
			onclose?.();
			closed.resolve();
		};
		await writeGrantFromAnotherProcess(policy, false);
		await bounded(closed.promise);
	} else {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const resolve = policy.resolve.bind(policy);
		vi.spyOn(policy, "resolve").mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return resolve(...args);
		});
		const pending = service.reconnectServer("project-envprobe");
		const rejected = expect(pending).rejects.toMatchObject({ retriable: true, phase: "connect" });
		let offInvalidated = () => {};
		try {
			await bounded(entered.promise);
			const invalidated = Promise.withResolvers<void>();
			offInvalidated = connection.onStateChange((event) => {
				if (event.state === "idle") invalidated.resolve();
			});
			await writeGrantFromAnotherProcess(policy, false);
			await bounded(invalidated.promise);
		} finally {
			offInvalidated();
			release.resolve();
		}
		await bounded(rejected);
	}
	// Then: no revoked transport survives or materializes after the revoke.
	expect(connection.state).not.toBe("connected");
	expect(() => connection.client).toThrow();
});
