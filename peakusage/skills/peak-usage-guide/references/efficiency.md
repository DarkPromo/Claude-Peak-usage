# Efficiency playbook

Why this matters: every turn re-reads the whole conversation. Tokens that enter the context early are paid for again on each later turn, and stale or noisy history also makes the model less precise. Each habit below either keeps tokens out of the context or keeps their cost from repeating.

## Contents
- Habits Claude applies without asking
- Habits only the user can apply
- Prompt cache
- Claude chat and Cowork
- Anti-patterns

## Habits Claude applies without asking

| Habit | How | Why it pays |
| --- | --- | --- |
| Narrow reads | Search first (Grep with `files_with_matches` or a `head_limit`), then Read the relevant line range with `offset`/`limit`. | A whole-file read of a 2,000-line file is paid for on every later turn. |
| Bound command output | Pipe long output through `head`/`tail`, use quiet or summary flags (`--stat`, `-q`, `--short`), and show only failing tests. | Logs are the biggest source of tokens that never matter again. |
| No re-reading | Do not re-read a file already in context unless it changed or you need a line you did not keep. After your own edit, trust the tool's success result. | Duplicate copies of a file waste space and can disagree with each other. |
| Batch independent calls | Issue unrelated reads and searches in one message. | Fewer round trips, each of which re-sends the context. |
| Delegate noisy exploration | Send broad searches ("where is X used across the repo") to a subagent, such as the Explore agent, and ask for the conclusion with file:line pointers. | The subagent's file dumps stay in its own context; only the answer returns. Skip it for a lookup you can do in two calls, since a subagent starts cold. |
| Point, don't paste | Refer to `path:line` or a URL instead of quoting code or logs back into the conversation. | Quoted material is stored twice: once at the source, once in history. |
| Settle before building | For a change that touches many files, state the plan and confirm the unclear parts first, or use Plan mode. | A wrong direction costs the whole exploration plus the undo. |
| Edit, don't regenerate | Change the lines that need changing; do not rewrite a whole file or document to fix a paragraph. | Output tokens cost more than input, and a rewrite also risks unrelated changes. |

## Habits only the user can apply

Claude cannot type slash commands for the user, so offer these as one-line suggestions at a natural boundary, once. Do not repeat them.

| Situation | Suggest |
| --- | --- |
| A new, unrelated task starts in a long session | `/clear`, which drops history that no longer applies. `/resume` brings an old session back. |
| Same task, history is long and noisy, a natural break has come | `/compact` with a focus, for example `/compact keep the failing test list and the schema decision`. The focus text decides what survives, so name it. |
| Unsure what is filling the window | `/context` shows what occupies it. Large always-loaded items (long project instructions, many connected tool servers) are paid for on every turn. |
| Substantial work remains, the next phase needs few facts from history, or compaction would blur exact details | A handoff (`/peakusage:handoff`) and a fresh session. |
| Wants to see spend | `/cost` or `/usage`, where the plan exposes them. |
| Using a top-tier model for routine searching and reading | `/model` to a lighter one for that phase; keep the strongest for design and debugging. |

Keep project instructions (`CLAUDE.md`) short and put rarely needed detail in files Claude reads on demand. Turn off tool servers a session will not use.

## Prompt cache

Claude reuses the unchanged start of the conversation at a much lower cost. That reuse has a limited lifetime, so:
- A long pause can expire it; the next turn then pays full price for the whole context. Before a long break, a short handoff is cheaper than resuming a very large context cold.
- Changing the model, the tool list, or the project instructions mid-session changes the start of the context and can discard the reuse. Make those changes at a natural break, not mid-task.
- Do not infer an exact lifetime. It depends on the plan and setup; if the host exposes cache or cost figures, read them instead of assuming.

## Claude chat and Cowork

- One topic per chat. Start a new chat with a handoff when the topic changes or the chat gets long.
- Put material that many chats reuse (style guide, reference documents) in a Project instead of re-attaching it.
- Attach only the pages or sheets that matter; a 200-page PDF is read on every turn.
- Ask for the edit ("change section 3 to...") rather than a full regeneration.
- Ask for the answer first and the detail on request.

## Anti-patterns

- Rolling over when nearly done. The handoff costs more than finishing.
- Rolling over mid-operation or while waiting on the user. State in flight is the hardest thing to transfer.
- Compacting with no focus, then wondering why an exact constraint disappeared. If precision matters, write it into a file first.
- Handoffs that paste logs and code. They recreate the bloat they were meant to remove.
- Spawning a subagent per tiny lookup.
