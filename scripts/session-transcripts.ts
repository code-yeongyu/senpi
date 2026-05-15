#!/usr/bin/env npx tsx
/**
 * Extracts session transcripts for a given cwd, splits into context-sized files,
 *
 * Usage: npx tsx scripts/session-transcripts.ts [--output <dir>] [cwd]
 *   --output <dir> Output directory for transcript files (defaults to ./session-transcripts)
 *   cwd            Working directory to extract sessions for (defaults to current)
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { parseSessionEntries, type SessionMessageEntry } from "../packages/coding-agent/src/core/session-manager.js";
import chalk from "chalk";

const MAX_CHARS_PER_FILE = 100_000; // ~20k tokens, leaving room for prompt + analysis + output

function cwdToSessionDir(cwd: string): string {
	const normalized = resolve(cwd).replace(/\//g, "-");
	return `--${normalized.slice(1)}--`; // Remove leading slash, wrap with --
}

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");
}

function parseSession(filePath: string): string[] {
	const content = readFileSync(filePath, "utf8");
	const entries = parseSessionEntries(content);
	const messages: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msgEntry = entry as SessionMessageEntry;
		const { role, content } = msgEntry.message;

		if (role !== "user" && role !== "assistant") continue;

		const text = extractTextContent(content as string | Array<{ type: string; text?: string }>);
		if (!text.trim()) continue;

		messages.push(`[${role.toUpperCase()}]\n${text}`);
	}

	return messages;
}

async function main() {
	const args = process.argv.slice(2);

	// Parse --output <dir>
	const outputIdx = args.indexOf("--output");
	let outputDir = resolve("./session-transcripts");
	if (outputIdx !== -1 && args[outputIdx + 1]) {
		outputDir = resolve(args[outputIdx + 1]);
	}

	// Find cwd (positional arg that's not a flag or flag value)
	const flagIndices = new Set<number>();
	if (outputIdx !== -1) {
		flagIndices.add(outputIdx);
		flagIndices.add(outputIdx + 1);
	}
	const cwdArg = args.find((a, i) => !flagIndices.has(i) && !a.startsWith("--"));
	const cwd = resolve(cwdArg || process.cwd());

	mkdirSync(outputDir, { recursive: true });
	const sessionsBase = join(homedir(), ".pi/agent/sessions");
	const sessionDirName = cwdToSessionDir(cwd);
	const sessionDir = join(sessionsBase, sessionDirName);

	if (!existsSync(sessionDir)) {
		console.error(`No sessions found for ${cwd}`);
		console.error(`Expected: ${sessionDir}`);
		process.exit(1);
	}

	const sessionFiles = readdirSync(sessionDir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort();

	console.log(`Found ${sessionFiles.length} session files in ${sessionDir}`);

	// Collect all transcripts
	const allTranscripts: string[] = [];
	for (const file of sessionFiles) {
		const filePath = join(sessionDir, file);
		const messages = parseSession(filePath);
		if (messages.length > 0) {
			allTranscripts.push(`=== SESSION: ${file} ===\n${messages.join("\n---\n")}\n=== END SESSION ===`);
		}
	}

	if (allTranscripts.length === 0) {
		console.error("No transcripts found");
		process.exit(1);
	}

	// Split into files respecting MAX_CHARS_PER_FILE
	const outputFiles: string[] = [];
	let currentContent = "";
	let fileIndex = 0;

	for (const transcript of allTranscripts) {
		// If adding this transcript would exceed limit, write current and start new
		if (currentContent.length > 0 && currentContent.length + transcript.length + 2 > MAX_CHARS_PER_FILE) {
			const filename = `session-transcripts-${String(fileIndex).padStart(3, "0")}.txt`;
			writeFileSync(join(outputDir, filename), currentContent);
			outputFiles.push(filename);
			console.log(`Wrote ${filename} (${currentContent.length} chars)`);
			currentContent = "";
			fileIndex++;
		}

		// If this single transcript exceeds limit, write it to its own file
		if (transcript.length > MAX_CHARS_PER_FILE) {
			// Write any pending content first
			if (currentContent.length > 0) {
				const filename = `session-transcripts-${String(fileIndex).padStart(3, "0")}.txt`;
				writeFileSync(join(outputDir, filename), currentContent);
				outputFiles.push(filename);
				console.log(`Wrote ${filename} (${currentContent.length} chars)`);
				currentContent = "";
				fileIndex++;
			}
			// Write the large transcript to its own file
			const filename = `session-transcripts-${String(fileIndex).padStart(3, "0")}.txt`;
			writeFileSync(join(outputDir, filename), transcript);
			outputFiles.push(filename);
			console.log(chalk.yellow(`Wrote ${filename} (${transcript.length} chars) - oversized`));
			fileIndex++;
			continue;
		}

		currentContent += (currentContent ? "\n\n" : "") + transcript;
	}

	// Write remaining content
	if (currentContent.length > 0) {
		const filename = `session-transcripts-${String(fileIndex).padStart(3, "0")}.txt`;
		writeFileSync(join(outputDir, filename), currentContent);
		outputFiles.push(filename);
		console.log(`Wrote ${filename} (${currentContent.length} chars)`);
	}

	console.log(`\nCreated ${outputFiles.length} transcript file(s) in ${outputDir}`);
}

main().catch(console.error);
