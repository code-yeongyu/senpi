#!/usr/bin/env node
import { readFileSync } from "node:fs";

// These reviewed exceptions are temporary; removing their .npmrc entries retires the gate.
const expiresAfter = "2026-09-15";
const today = new Date().toISOString().slice(0, 10);
const npmrc = readFileSync(".npmrc", "utf8");
const exclusions = new Set(
	[...npmrc.matchAll(/^\s*min-release-age-exclude\[\]\s*=\s*([^\r\n]+)$/gm)].map((match) => match[1].trim()),
);

for (const packageName of ["marked", "zod"]) {
	if (today <= expiresAfter || !exclusions.has(packageName)) continue;
	console.error(JSON.stringify({
		code: "release_age_exception_expired",
		packageName,
		expiresAfter,
		today,
		action: "Remove the expired min-release-age-exclude entry from .npmrc.",
	}));
	process.exitCode = 1;
}
