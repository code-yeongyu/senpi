# Sessions

Senpi saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Session Storage

Sessions auto-save to `~/.senpi/agent/sessions/`, organized by working directory. Each session is a JSONL file with a tree structure. The file is created when the first user message is sent, so a session is not lost if senpi exits before the first assistant response.

```bash
senpi -c                  # Continue most recent session
senpi -r                  # Browse and select from past sessions
senpi --no-session        # Ephemeral mode; do not save
senpi --name "my task"    # Set session display name at startup
senpi --session <path|id> # Use a specific session file or partial session ID
senpi --fork <path|id>    # Fork a session file or partial session ID into a new session
senpi --rebind <path|id>  # Move a session of this repository, recorded at another path, here
```

Use `/session` in interactive mode to see the current session file, session ID, message count, tokens, and cost.

### Moved or re-cloned repositories

Sessions are filed by the directory they started in. Each session also records which git repository that directory belonged to (its root commit and `origin` remote), so it can still be recognised after the repository moves.

When `--session <id>` (or a pick in `--resume`) finds a session filed under another path and the current directory is the same git repository, senpi shows both paths and offers to move the session here. Answering `y` rebinds it: the session file moves to the current project, its recorded working directory is updated, and it keeps its id, history, goal, loops, and monitors. The old path no longer lists it. Use `--fork <id>` to copy it into a new session instead. A session from a different repository gets the fork prompt as before.

The in-session `/resume` selector asks the same question when you pick such a session; answering No opens it where it is. The current-folder view of `/resume` and `--resume` also lists this repository's sessions whose old path no longer exists, marked "moved from <old path>", and `--continue` in a project with no session of its own offers the newest of them.

A session that another senpi process still has open is never moved: the move stops and names that process (pid and directory) so you can quit it first. Each open session is advertised under `session-holders/` next to the session file; a record left by a process that has exited is ignored.

`--rebind <path|id>` does the same without asking, for scripts. It refuses when the two directories are provably different repositories. Without an interactive terminal, `--session` never prompts: it prints the exact `--rebind` and `--fork` commands and exits with a non-zero status.

For the JSONL file format and SessionManager API, see [Session Format](session-format.md).

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/new` | Start a new session |
| `/rename [name]` | Rename the current session (`/name` is an alias) |
| `/session` | Show session info |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

## Resuming and Deleting Sessions

`/resume` opens an interactive session picker for the current project. `senpi -r` opens the same picker at startup.

In the picker you can:

- search by typing
- toggle path display with Ctrl+P
- toggle sort mode with Ctrl+S
- filter to named sessions with Ctrl+N
- rename with Ctrl+R
- delete with Ctrl+D, then confirm

When available, senpi uses the `trash` CLI for deletion instead of permanently removing files.

## Naming Sessions

Use `/rename [name]` to set a human-readable session name. With an argument it sets the name immediately; without one it opens an inline editor prefilled with the current name (Enter commits, Esc cancels, empty names are rejected). `/name` is an alias.

```text
/rename Refactor auth module
```

Set the name at startup with `--name` or `-n`:

```bash
senpi --name "Refactor auth module"
senpi --name "CI audit" -p "Review this build failure"
```

Named sessions are easier to find in `/resume` and `senpi -r`.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating a new file.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600"></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| Ctrl+←/Ctrl+→ or Alt+←/Alt+→ | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label on the selected entry |
| Shift+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/Ctrl+C | Cancel |
| Ctrl+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](settings.md).

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

RPC clients get the same rule without an interactive picker. `navigate_tree` with `entryId` applies this selection behavior by default on the host and returns the text that would have gone to the editor as `editorText`; `edit_user_message` goes one step further and writes the edited prompt into the session as a new branch. To resume an existing branch at its exact entry instead (including an unanswered edited user message), use `navigate_tree` with `intent: "resume"`: the requested entry stays the leaf and no editor text is returned. Both intents are described in [RPC](rpc.md#navigate_tree).

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session file | New session file | New session file |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session file.

## Branch Summaries

When `/tree` switches away from one branch to another, senpi can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, labels, compactions, branch summaries, and extension entries.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](session-format.md).
