# Compaction Guide

Pi's compaction system helps you work on complex tasks that would otherwise exceed the LLM's context window. This guide explains how compaction works from a user perspective and how to get the most out of it.

## What is Compaction?

LLMs have finite context windows. When conversations grow too long, pi uses compaction to summarize older messages while preserving recent ones. Think of it like taking notes during a long meeting: you write down the key decisions and next steps so you can continue the conversation without remembering every word that was said.

Compaction happens automatically when needed, or you can trigger it manually with the `/compact` command.

## How It Works

### Automatic Compaction

When the conversation approaches the context limit, pi automatically compacts older messages. You'll see a `[compaction]` message in the TUI with a summary like "Compacted from 45000 tokens". The conversation continues seamlessly.

### Manual Compaction

Use `/compact` to trigger compaction on demand. This is useful when:

- You want to free up context before a complex operation
- You're about to switch topics and want a clean slate
- Auto-compaction hasn't triggered yet but you know the context is cluttered

Add custom instructions to focus the summary: `/compact focus on the API design decisions`. The summarizer will prioritize that aspect.

### What You See in the TUI

When compaction occurs, you'll see:

```
[compaction] Compacted from 45000 tokens (Ctrl+O to expand)
```

Press `Ctrl+O` (or your configured expand keybinding) to view the full summary. The summary follows a structured format covering goals, progress, decisions, and next steps.

### Your History is Never Lost

Compaction only affects what the LLM sees in its context window. The full conversation history remains in your session file. Use `/tree` to navigate back to any point before compaction and see the complete, un-summarized history.

## What Gets Preserved vs Lost

### Preserved

- Goals and objectives you've stated
- Progress tracking (what's done, in progress, blocked)
- Key decisions and their rationale
- File paths and function names
- Error messages and their resolutions
- Next steps and action items
- Critical context needed to continue

### Potentially Lost

- Exact wording of old messages
- Nuanced tone or style preferences mentioned early
- Very detailed tool output (summarized instead)
- Transient discussion that didn't result in decisions

### The Summary Format

Compaction produces structured summaries in this format:

```markdown
## Goal
What you're trying to accomplish

## Constraints & Preferences
Requirements and preferences you've mentioned

## Progress
### Done
- [x] Completed tasks

### In Progress
- [ ] Current work

### Blocked
Any issues

## Key Decisions
- **[Decision]**: Rationale

## Next Steps
1. What should happen next

## Critical Context
Data needed to continue

<read-files>
path/to/file1.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

## Branch Summarization

When you use `/tree` to switch to a different branch, pi offers to summarize the work you're leaving behind. This injects context from the abandoned branch into your new position.

### User Experience

After selecting a target in `/tree`, pi asks: "Summarize branch?" You have three options:

1. **No summary** - Switch immediately
2. **Summarize** - Generate a summary using the default prompt
3. **Summarize with custom prompt** - Add focus instructions

The summary appears as a `branch_summary` entry in your new branch, providing context about what was explored on the path you left.

### Skipping the Prompt

If you frequently switch branches and don't want the prompt, set `branchSummary.skipPrompt: true` in your settings. Pi will switch branches without asking.

## Settings & Tuning

Configure compaction in `~/.senpi/agent/settings.json` (global) or `.senpi/settings.json` (project):

```json
{
   "compaction": {
      "enabled": true,
      "reserveTokens": 16384,
      "keepRecentTokens": 20000
   },
   "branchSummary": {
      "reserveTokens": 16384,
      "skipPrompt": false
   }
}
```

### Compaction Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `compaction.enabled` | `true` | Enable auto-compaction. Set to `false` for manual control only. |
| `compaction.reserveTokens` | `16384` | Tokens reserved for the LLM's response. Lower values allow more context but risk truncation. |
| `compaction.keepRecentTokens` | `20000` | How much recent conversation to keep uncompressed. Higher values preserve more context but trigger compaction sooner. |

### Branch Summary Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `branchSummary.reserveTokens` | `16384` | Tokens reserved when generating branch summaries |
| `branchSummary.skipPrompt` | `false` | Skip the "Summarize branch?" prompt when using `/tree` |

### Tuning Recommendations

**For complex, multi-file tasks:**
Increase `keepRecentTokens` to 40000 or higher. This preserves more of the recent conversation, helping the model remember intricate relationships between files.

**For simple tasks with lots of back-and-forth:**
The defaults work well. Frequent compaction keeps context fresh without losing important state.

**If the model seems forgetful:**
Check if compaction happened recently (look for the `[compaction]` marker). Expand it to review summary quality. If key information is missing, mention it again in your next message. It will be included in the next compaction's "Critical Context" section.

## Practical Tips

### Long Sessions Are Fine

Compaction lets sessions run indefinitely. Don't worry about starting fresh sessions just to manage context. Pi handles it automatically.

### If Something Gets Forgotten

If the model forgets something after compaction:

1. Mention it again explicitly in your next message
2. Use `/compact "focus on X"` to ensure it's captured
3. Navigate back via `/tree` to the point before compaction if you need the exact details

### Use Custom Instructions

When compacting manually, tell the summarizer what matters:

```
/compact focus on the database schema decisions and migration plan
```

This shapes the summary to preserve what's relevant for your next steps.

### Navigate Back Anytime

The full history is always available via `/tree`. Compaction doesn't delete anything. It just changes what the LLM sees in its working context.

### Multiple Compactions Stack

Each new compaction builds on the previous summary. The summarizer sees the earlier summary and the new messages to summarize, producing an iteratively refined context. This works well for long-running tasks where understanding evolves over time.

## Customization via Extensions

Extensions can customize compaction behavior entirely. You can:

- Replace the default summarizer with your own
- Add custom data to compaction entries
- Trigger compaction on custom events
- Modify the summary format

For technical details, see:

- [`compaction.md`](compaction.md) - Internals and extension hooks
- [`extensions.md`](extensions.md) - Extension API reference
- [`examples/extensions/custom-compaction.ts`](../examples/extensions/custom-compaction.ts) - Working example

## FAQ / Troubleshooting

### "The model forgot something important"

**Check:** Look for the `[compaction]` marker in the conversation. Expand it with `Ctrl+O` to see what was preserved.

**Fix:** Re-mention the forgotten information. It will be included in the next compaction. Consider increasing `keepRecentTokens` if this happens frequently.

### "Compaction keeps triggering too often"

**Cause:** Your `reserveTokens` may be too low for your typical response sizes, or you're using a model with a small context window.

**Fix:** Increase `reserveTokens` (e.g., to 24000) or switch to a model with a larger context window. You can also increase `keepRecentTokens` to reduce compaction frequency.

### "I want to disable auto-compaction"

Set `compaction.enabled: false` in your settings. Use `/compact` manually when you want to compact. Be aware that without auto-compaction, long sessions may hit context limits and fail.

### "How do I see what was compacted?"

Expand the `[compaction]` message with `Ctrl+O` (or your configured expand keybinding). For the complete, un-summarized history, use `/tree` to navigate back to any point before the compaction.

### "Can I recover the full conversation after compaction?"

Yes. The full history is in your session file. Use `/tree` to navigate to any point before compaction and view the complete messages. Compaction only affects the LLM's working context, not the stored session.

## See Also

- [`compaction.md`](compaction.md) - Technical internals and extension hooks
- [`settings.md`](settings.md) - Complete settings reference
- [`tree.md`](tree.md) - Session tree navigation
- [`extensions.md`](extensions.md) - Extension API for custom compaction
- [`session.md`](session.md) - Session file format
