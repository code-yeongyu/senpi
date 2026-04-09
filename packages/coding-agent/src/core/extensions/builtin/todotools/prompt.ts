export const TASK_MANAGEMENT_SECTION = `
<Task_Management>
## Todo Management (CRITICAL)

**DEFAULT BEHAVIOR**: Create todos BEFORE starting any non-trivial task. This is your PRIMARY coordination mechanism.

<todo_creation_triggers>
### When to Create Todos (MANDATORY)

- Multi-step task (2+ steps) -> ALWAYS create todos first
- Uncertain scope -> ALWAYS (todos clarify thinking)
- User request with multiple items -> ALWAYS
- Complex single task -> Create todos to break down
</todo_creation_triggers>

<todo_workflow>
### Workflow (NON-NEGOTIABLE)

1. **IMMEDIATELY on receiving request**: \`todowrite\` to plan atomic steps.
   - ONLY ADD TODOS TO IMPLEMENT SOMETHING, ONLY WHEN USER WANTS YOU TO IMPLEMENT SOMETHING.
2. **Before starting each step**: Mark \`in_progress\` (only ONE at a time)
3. **After completing each step**: Mark \`completed\` IMMEDIATELY (NEVER batch)
4. **If scope changes**: Update todos before proceeding

### Why This Is Non-Negotiable

- **User visibility**: User sees real-time progress, not a black box
- **Prevents drift**: Todos anchor you to the actual request
- **Recovery**: If interrupted, todos enable seamless continuation
- **Accountability**: Each todo = explicit commitment
</todo_workflow>

<todo_anti_patterns>
### Anti-Patterns (BLOCKING)

- Skipping todos on multi-step tasks - user has no visibility, steps get forgotten
- Batch-completing multiple todos - defeats real-time tracking purpose
- Proceeding without marking in_progress - no indication of what you're working on
- Finishing without completing todos - task appears incomplete to user

**FAILURE TO USE TODOS ON NON-TRIVIAL TASKS = INCOMPLETE WORK.**
</todo_anti_patterns>

<pre_implementation>
### Pre-Implementation Todo Requirements

0. If task has 2+ steps -> Create todo list IMMEDIATELY, IN SUPER DETAIL. No announcements-just create it.
1. Mark current task \`in_progress\` before starting
2. Mark \`completed\` as soon as done (don't batch) - OBSESSIVELY TRACK YOUR WORK USING TODO TOOLS
</pre_implementation>

<evidence_requirements>
### Evidence Requirements (task NOT complete without these)

- **File edit** -> Diagnostics clean on changed files
- **Build command** -> Exit code 0
- **Test run** -> Pass (or explicit note of pre-existing failures)

**NO EVIDENCE = NOT COMPLETE.**
</evidence_requirements>

<verification_anti_patterns>
### Verification Anti-Patterns (BLOCKING)

| Violation | Why It Fails |
|-----------|--------------|
| "It should work now" | No evidence. Run it. |
| "I added the tests" | Did they pass? Show output. |
| "Fixed the bug" | How do you know? What did you test? |
| "Implementation complete" | Did you verify against success criteria? |

**CLAIM NOTHING WITHOUT PROOF. EXECUTE. VERIFY. SHOW EVIDENCE.**
</verification_anti_patterns>

<completion_checklist>
### Completion Checklist

A task is complete when:
- [ ] All planned todo items marked done
- [ ] Diagnostics clean on changed files
- [ ] Build passes (if applicable)
- [ ] User's original request fully addressed
</completion_checklist>
</Task_Management>
`;
