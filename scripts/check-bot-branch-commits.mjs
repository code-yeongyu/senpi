#!/usr/bin/env node
// Refuses a generated-data automation branch that carries commits the bot did not write (#3243).
// A hand merge of main into automation/opengateway-catalog-refresh kept the branch's older catalog
// snapshot over newer data on main; the branch must only ever hold the bot's regeneration.
// Author and committer emails are both checked. Either can be set by hand, so this guards against
// accidents (a hand merge, a web "Update branch"), not against someone forging the bot identity.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function foreignCommits({ cwd, base, head, botEmail }) {
	const log = execFileSync("git", ["log", "--format=%H%x09%ae%x09%ce%x09%s", "--end-of-options", `${base}..${head}`], {
		cwd,
		encoding: "utf8",
	});
	return log
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha, email, committerEmail, ...subject] = line.split("\t");
			return { sha, email, committerEmail, subject: subject.join("\t") };
		})
		.filter((commit) => commit.email !== botEmail || commit.committerEmail !== botEmail);
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]?.replace(/^--/, "");
		const value = argv[i + 1];
		if (!key || value === undefined) throw new Error(`usage: --base <ref> --head <ref> --bot-email <email>`);
		args[key] = value;
	}
	for (const required of ["base", "head", "bot-email"]) {
		if (!args[required]) throw new Error(`missing --${required}`);
	}
	return args;
}

// Compare real file URLs: a hand-built "file://" + argv[1] misses a path with spaces or a symlink,
// and a missed entry check would exit 0 without checking anything.
const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
	const args = parseArgs(process.argv.slice(2));
	const foreign = foreignCommits({
		cwd: process.cwd(),
		base: args.base,
		head: args.head,
		botEmail: args["bot-email"],
	});
	if (foreign.length > 0) {
		console.error(
			`Refusing ${args.head}: it carries ${foreign.length} commit(s) not written by ${args["bot-email"]}. ` +
				"An automation branch must hold only the bot's regeneration; close the PR and let the workflow regenerate from main.",
		);
		for (const commit of foreign) {
			const committer = commit.committerEmail === commit.email ? "" : ` [committer ${commit.committerEmail}]`;
			console.error(`  ${commit.sha.slice(0, 10)} ${commit.email}${committer} ${commit.subject}`);
		}
		process.exit(1);
	}
	console.log(`${args.head}: only ${args["bot-email"]} commits since ${args.base}.`);
}
