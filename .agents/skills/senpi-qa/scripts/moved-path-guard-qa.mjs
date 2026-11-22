#!/usr/bin/env node
// senpi-qa driver for the moved-path-guard builtin extension (#2898).
// A sandboxed HOME holds an OmO desktop home that moved from ~/.t3 to ~/.omo/desktop, with the
// desktop's breadcrumb left in ~/.t3. The REAL CLI runs scripted tool calls from the local fake
// model server (zero tokens) and the driver asserts, from the next provider request and the
// filesystem: writes and shell commands that target a moved prefix are refused with the new
// path, a read of a moved path gets the hint, an unlisted path under the breadcrumb is left
// alone, and nothing is created under the old prefix.
//
//   node .agents/skills/senpi-qa/scripts/moved-path-guard-qa.mjs --self-test
//   node .agents/skills/senpi-qa/scripts/moved-path-guard-qa.mjs --self-test --evidence moved-path-guard
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox, runCli } from "./lib/common.mjs";
import { startFakeModelServer } from "./lib/fake-model-server.mjs";
import { API_PRESETS, checkRealAuthUnchanged, hermeticEnv, writeMockModelsJson } from "./lib/mock-loop-support.mjs";

const argv = process.argv.slice(2);
const evidenceSlug = argv.includes("--evidence") ? argv[argv.indexOf("--evidence") + 1] : undefined;
const API = "openai-completions";
const WORKTREE = join("worktrees", "demo-project", "feature-1");
// Third review M-a: a listed prefix whose old folder still exists but cannot be searched, so a lookup under it fails.
const UNSEARCHABLE = join("worktrees", "slow-project", "feature-2");
// Third review M-b: a listed worktree a later T3 Code checkout reused (its own .git): never moved.
const REUSED = join("worktrees", "reused-project", "feature-3");

function seedMovedHome(home) {
	const oldHome = join(home, ".t3");
	const newHome = join(home, ".omo", "desktop");
	mkdirSync(join(newHome, WORKTREE), { recursive: true });
	writeFileSync(join(newHome, WORKTREE, "notes.txt"), "moved content\n");
	mkdirSync(join(newHome, "userdata", "omo-sessions"), { recursive: true });
	// The desktop's ownership marker (plan section 2); a breadcrumb is trusted only when its home carries it.
	writeFileSync(
		join(newHome, "omo-desktop-home.json"),
		`${JSON.stringify({ kind: "omo-desktop-data-home", appId: "com.omo.desktop", schemaVersion: 1, homeId: "qa-home-0001" })}\n`,
	);
	mkdirSync(oldHome, { recursive: true });
	writeFileSync(
		join(oldHome, "omo-desktop-moved.json"),
		`${JSON.stringify(
			{
				kind: "omo-desktop-moved",
				schemaVersion: 1,
				movedTo: newHome,
				homeId: "qa-home-0001",
				movedAt: "2026-10-08T00:00:00.000Z",
				byVersion: "qa",
				moved: [WORKTREE, "userdata/omo-sessions", UNSEARCHABLE, REUSED],
			},
			null,
			2,
		)}\n`,
	);
	mkdirSync(join(oldHome, REUSED), { recursive: true });
	writeFileSync(join(oldHome, REUSED, ".git"), "gitdir: /elsewhere/.git/worktrees/feature-3\n");
	mkdirSync(join(oldHome, "worktrees", "slow-project"), { recursive: true });
	chmodSync(join(oldHome, "worktrees", "slow-project"), 0o000);
	return { oldHome, newHome };
}

function shellInEval(command) {
	return {
		name: "eval",
		args: { language: "js", summary: "shell command by an old path", code: `const r = await tool.bash({ command: ${JSON.stringify(command)} }); return r.text;` },
	};
}

function toolResultTexts(requests) {
	const texts = [];
	for (const request of requests) {
		for (const message of request.body?.messages ?? []) {
			if (message.role !== "tool") continue;
			const content = message.content;
			texts.push(typeof content === "string" ? content : JSON.stringify(content));
		}
	}
	return [...new Set(texts)];
}

// Fifth review M-2 (HOME is a symlink) and sixth review MEDIUM-1 (~/.t3 is a symlink to another folder): the walk sees
// the old root realpath'd while commands name ~/.t3. After one refusal has trusted the breadcrumb, 70 unlisted ~/.t3
// paths ahead of a moved target must not push it past the probe budget.
async function symlinkedRootCase(checks, preset, symlinked) {
	const box = makeSandbox(`moved-path-guard-qa-${symlinked}`);
	const realHome = realpathSync(box.dir);
	const link = symlinked === "home" ? `${realHome}-homelink` : `${realHome}-ext-t3`;
	const { oldHome, newHome } = seedMovedHome(realHome);
	const realOldHome = symlinked === "home" ? oldHome : link;
	if (symlinked === "home") symlinkSync(realHome, link);
	else {
		renameSync(oldHome, link);
		symlinkSync(link, oldHome);
	}
	const home = symlinked === "home" ? link : box.dir;
	const unlisted = Array.from({ length: 70 }, (_, index) => `~/.t3/unlisted/d${index}`).join(" ");
	const server = await startFakeModelServer({
		turns: [
			{ toolCalls: [shellInEval(`touch ~/.t3/${WORKTREE}/trust.txt`)] },
			{ toolCalls: [shellInEval(`mkdir -p ~/.t3/unlisted && touch ${unlisted} ~/.t3/${WORKTREE}/alias.txt`)] },
			{ text: "done" },
		],
	});
	writeMockModelsJson(box.agentDir, server, API);
	const result = await runCli(
		["--provider", preset.provider, "--model", preset.modelId, "--no-context-files", "--no-extensions", "--approve", "--print", "Run the scripted tools, then reply done."],
		{ env: hermeticEnv({ ...box.env, HOME: home, USERPROFILE: home }), cwd: box.cwd, timeoutMs: 180000 },
	);
	const results = toolResultTexts(server.requests);
	const refused = results.find((text) => /moved/i.test(text) && text.includes(join(newHome, WORKTREE, "alias.txt")));
	const finding = symlinked === "home" ? "M-2: with a symlinked HOME" : "MEDIUM-1: with a symlinked ~/.t3";
	checks.ok(`symlinked ${symlinked}: run completed`, result.code === 0, `code=${result.code}`);
	checks.ok(
		`${finding} a moved target behind 70 unlisted ~/.t3 paths is refused`,
		refused !== undefined && !existsSync(join(realOldHome, WORKTREE, "alias.txt")),
		refused?.slice(0, 160) ?? results.at(-1)?.slice(0, 160) ?? "no refusal",
	);
	await server.stop();
	chmodSync(join(realOldHome, "worktrees", "slow-project"), 0o700);
	rmSync(link, { recursive: true, force: true });
	box.cleanup();
	return results.map((text) => text.replaceAll(realHome, "<HOME>"));
}

async function selfTest() {
	installCleanupHooks();
	const checks = createChecks("moved-path-guard-qa.mjs --self-test");
	const guard = guardRealAuth();
	const preset = API_PRESETS[API];
	const box = makeSandbox("moved-path-guard-qa");
	const { oldHome, newHome } = seedMovedHome(box.dir);
	const oldWorktree = join(oldHome, WORKTREE);
	const newWorktree = join(newHome, WORKTREE);
	// Review H1: a breadcrumb planted in a repository, pointing at a folder with no desktop marker, is ignored.
	const repo = join(box.dir, "repo");
	const elsewhere = join(box.dir, "elsewhere");
	mkdirSync(join(repo, "src"), { recursive: true });
	mkdirSync(join(box.dir, "locked", "inner"), { recursive: true });
	// Fourth review H-fifo: a FIFO named as a breadcrumb in an ancestor of a guarded path must never block the guard.
	mkdirSync(join(box.dir, "fifo-repo", "sub"), { recursive: true });
	execFileSync("mkfifo", [join(box.dir, "fifo-repo", "omo-desktop-moved.json")]);
	chmodSync(join(box.dir, "locked"), 0o000);
	mkdirSync(elsewhere, { recursive: true });
	writeFileSync(
		join(repo, "omo-desktop-moved.json"),
		JSON.stringify({ kind: "omo-desktop-moved", schemaVersion: 1, movedTo: elsewhere, homeId: "qa-home-0001", moved: ["src"] }),
	);
	const turns = [
		{ toolCalls: [{ name: "write", args: { path: join(oldWorktree, "edit.txt"), content: "hi\n" } }] },
		{ toolCalls: [{ name: "eval", args: { language: "js", summary: "shell write by the old path", code: `const r = await tool.bash({ command: "mkdir -p ~/.t3/${WORKTREE}/x && echo hi > ~/.t3/${WORKTREE}/x/y" }); return r.text;` } }] },
		{ toolCalls: [{ name: "read", args: { path: join(oldWorktree, "notes.txt") } }] },
		{ toolCalls: [{ name: "write", args: { path: join(oldHome, "unlisted.txt"), content: "t3 code's own file\n" } }] },
		{ toolCalls: [{ name: "write", args: { path: join(newWorktree, "edit.txt"), content: "hi\n" } }] },
		// Review H2: a path written out inside inline code, and one split by shell quoting (bash runs inside eval here).
		{ toolCalls: [shellInEval(`python3 -c "open('${oldWorktree}/py.txt','w').write('x')"`)] },
		{ toolCalls: [shellInEval(`mkdir -p "$HOME"/.t3/${WORKTREE}/q`)] },
		// Review M2: a relative path after cd in the same command; only the nested bash call can see it.
		{ toolCalls: [shellInEval(`cd ~/.t3 && mkdir -p ${WORKTREE}/cdx`)] },
		// Review M3: eval code that writes by the old path itself, with no nested tool call.
		{ toolCalls: [{ name: "eval", args: { language: "js", summary: "direct fs write by the old path", code: `const fs = await import("node:fs"); fs.writeFileSync("${oldWorktree}/eval.txt", "x"); return "wrote";` } }] },
		{ toolCalls: [{ name: "write", args: { path: join(repo, "src", "planted.txt"), content: "repo file\n" } }] },
		// Third review M-a: a moved path whose own lookup fails is still refused.
		{ toolCalls: [shellInEval(`touch ${join(oldHome, UNSEARCHABLE, "slow.txt")}`)] },
		// Third review M-b: 70 paths inside the re-used worktree, past the per-call probe budget.
		{
			toolCalls: [
				shellInEval(
					`touch ${Array.from({ length: 70 }, (_, index) => join(oldHome, REUSED, `f${index}.ts`)).join(" ")} && echo reused-ok`,
				),
			],
		},
		{ toolCalls: [shellInEval(`touch ${join(box.dir, "fifo-repo", "sub", "x")} && echo fifo-ok`)] },
		// Re-review H-new: a path the guard cannot resolve (not searchable here) never fails the call.
		{ toolCalls: [shellInEval(`ls ${join(box.dir, "locked", "inner", "foo")} 2>/dev/null; echo ran-after-unreadable`)] },
		{ text: "done" },
	];
	const server = await startFakeModelServer({ turns });
	writeMockModelsJson(box.agentDir, server, API);
	const result = await runCli(
		["--provider", preset.provider, "--model", preset.modelId, "--no-context-files", "--no-extensions", "--approve", "--print", "Run the scripted tools, then reply done."],
		{ env: hermeticEnv(box.env), cwd: box.cwd, timeoutMs: 180000 },
	);
	const results = toolResultTexts(server.requests);
	const mentionsNew = (text) => text.includes(newWorktree) || text.includes(newHome);
	const refusedWrite = results.find((text) => text.includes("edit.txt") && mentionsNew(text) && /moved/i.test(text));
	const refusedBash = results.find((text) => /moved/i.test(text) && text.includes(join(newHome, WORKTREE, "x")));
	const readHint = results.find((text) => text.includes("notes.txt") && mentionsNew(text));

	checks.ok("run completed", result.code === 0, `code=${result.code} requests=${server.requests.length}`);
	checks.ok("write to an old moved path is refused and names the new path", refusedWrite !== undefined, refusedWrite?.slice(0, 200) ?? "no refusal");
	checks.ok("bash in an eval cell naming ~/.t3/<moved prefix> is refused", refusedBash !== undefined, refusedBash?.slice(0, 200) ?? "no refusal");
	checks.ok("read of a moved path gets the hint with the new path", readHint !== undefined, readHint?.slice(0, 200) ?? "no hint");
	checks.ok("nothing created under the old moved prefix", !existsSync(oldWorktree), `exists=${existsSync(oldWorktree)}`);
	checks.ok("an unlisted path under the breadcrumb is written normally", existsSync(join(oldHome, "unlisted.txt")), "");
	checks.ok("the same write under the new path succeeds", existsSync(join(newWorktree, "edit.txt")), "");
	const refusedFor = (name) => results.find((text) => /moved/i.test(text) && text.includes(join(newWorktree, name)));
	checks.ok("H2: python -c with the old path inline is refused", refusedFor("py.txt") !== undefined, refusedFor("py.txt")?.slice(0, 160) ?? "no refusal");
	checks.ok('H2: "$HOME"/.t3/<moved prefix> is refused', refusedFor("q") !== undefined, refusedFor("q")?.slice(0, 160) ?? "no refusal");
	checks.ok("M2: a relative path after cd ~/.t3 is refused", refusedFor("cdx") !== undefined, refusedFor("cdx")?.slice(0, 160) ?? "no refusal");
	checks.ok("M3: eval code naming the old path is refused", refusedFor("eval.txt") !== undefined, refusedFor("eval.txt")?.slice(0, 160) ?? "no refusal");
	checks.ok("H1: a planted breadcrumb without a desktop marker is ignored", existsSync(join(repo, "src", "planted.txt")) && !existsSync(join(elsewhere, "src")), `repo=${existsSync(join(repo, "src", "planted.txt"))} redirected=${existsSync(join(elsewhere, "src"))}`);
	const ranUnreadable = results.find((text) => text.includes("ran-after-unreadable"));
	checks.ok("H-new: a command naming an unreadable path still runs", ranUnreadable !== undefined, ranUnreadable?.slice(0, 120) ?? "call failed");
	const refusedSlow = results.find((text) => /moved/i.test(text) && text.includes(join(newHome, UNSEARCHABLE, "slow.txt")));
	checks.ok("M-a: a moved path whose own lookup fails is still refused", refusedSlow !== undefined, refusedSlow?.slice(0, 140) ?? "no refusal");
	const reusedOk = results.find((text) => text.includes("reused-ok"));
	checks.ok(
		"M-b: 70 paths in a re-used worktree are allowed",
		reusedOk !== undefined && existsSync(join(oldHome, REUSED, "f69.ts")),
		reusedOk?.slice(0, 120) ?? results.find((text) => text.includes(REUSED))?.slice(0, 160) ?? "call refused",
	);
	const fifoOk = results.find((text) => text.includes("fifo-ok"));
	checks.ok("H-fifo: a FIFO named as a breadcrumb never blocks a call", fifoOk !== undefined, fifoOk?.slice(0, 120) ?? "call blocked or failed");
	checks.ok("the moved home's existing file is untouched", readFileSync(join(newWorktree, "notes.txt"), "utf8") === "moved content\n", "");

	if (result.code !== 0) process.stderr.write(`\n--- stderr tail ---\n${result.stderr.slice(-800)}\n`);
	await server.stop();
	chmodSync(join(box.dir, "locked"), 0o700);
	chmodSync(join(oldHome, "worktrees", "slow-project"), 0o700);
	box.cleanup();
	const aliasedResults = await symlinkedRootCase(checks, preset, "home");
	const legacyLinkResults = await symlinkedRootCase(checks, preset, "legacy-root");
	if (evidenceSlug !== undefined) {
		writeFileSync(
			join(evidenceDir(evidenceSlug), "moved-path-guard.json"),
			JSON.stringify({ exitCode: result.code, requestCount: server.requests.length, toolResults: results.map((text) => text.replaceAll(box.dir, "<HOME>")), aliasedHomeToolResults: aliasedResults, symlinkedLegacyRootToolResults: legacyLinkResults }, null, 2),
		);
	}
	checkRealAuthUnchanged(checks, guard);
	process.exit(checks.finish() ? 0 : 1);
}

await selfTest();
