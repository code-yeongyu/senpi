#!/usr/bin/env node
// Ownership of exclusive job temp scopes (`sj-*`) for scripts/test-temp-guard.mjs (#6862). Several guarded jobs on
// one machine all create their scopes in the shared system temp; the owner record lets one job's check tell a
// concurrent job's live scope from a scope its own tests leaked.
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const scopeOwnerFile = ".senpi-test-temp-scope.json";
const removal = { recursive: true, force: true, maxRetries: 3 };

// The record names the scope's own job registry and the registry of the guarded job that ran the snapshot, if any.
// Rename keeps a concurrent check from reading a partial record.
export function writeScopeOwner(scope, registry, parentRegistry) {
	const partial = join(scope, `${scopeOwnerFile}.partial`);
	writeFileSync(partial, JSON.stringify({ registry, parentRegistry: parentRegistry || null }));
	renameSync(partial, join(scope, scopeOwnerFile));
}

function missing(error) {
	if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return true;
	throw error;
}

// True when `file` lies inside `directory`, and, given a baseline, inside an entry created after it.
function createdUnder(file, directory, entries) {
	const path = relative(realpathSync(directory), file);
	if (!path || path.startsWith("..") || isAbsolute(path)) return false;
	return !entries || !entries.includes(path.split(sep)[0]);
}

// A fresh `sj-*` in system temp is a concurrent job's scope only when its record names a live registry that is not
// this job's, was not handed down from this job, and lies outside this job's scope and everything this job created
// since its snapshot. A missing, empty or forged record, or an owner that is gone, stays this job's leftover.
export function concurrentJobScope(path, snapshot) {
	if (!basename(path).startsWith("sj-")) return false;
	let owner;
	try {
		owner = JSON.parse(readFileSync(join(path, scopeOwnerFile), "utf8"));
	} catch (error) {
		// A scope that vanished since the listing was retired by its job's own check; an unmarked one is reported.
		return missing(error) && !existsSync(path);
	}
	const claimed = owner?.registry;
	if (typeof claimed !== "string" || !isAbsolute(claimed)) return false;
	if (claimed === snapshot.registry || owner.parentRegistry === snapshot.registry) return false;
	let live;
	try {
		live = realpathSync(claimed);
	} catch (error) {
		return !missing(error);
	}
	if (snapshot.scope && createdUnder(live, snapshot.scope)) return false;
	return !(snapshot.system ?? []).some(({ directory, entries }) => createdUnder(live, directory, entries));
}

// Leave the `sj-` namespace before deleting anything, so a concurrent check never sees this scope without its
// owner record. Where a handle pins the directory (win32) the rename fails; then the record is removed last.
export function retireScope(scope) {
	const retired = join(dirname(scope), `sj.retired-${basename(scope).slice(3)}`);
	try {
		renameSync(scope, retired);
	} catch (error) {
		if (error?.code === "ENOENT" && !existsSync(scope)) return;
		console.log(`[test-temp] retiring the job scope in place (${error.code ?? error}): ${JSON.stringify(scope)}`);
		for (const name of readdirSync(scope)) if (name !== scopeOwnerFile) rmSync(join(scope, name), removal);
		rmSync(scope, removal);
		return;
	}
	rmSync(retired, removal);
}
