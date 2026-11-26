---
name: peak-usage-guide
description: "Get more finished work out of Claude's context window and usage limits. Use whenever the user mentions running out of context, hitting a usage limit, a long session that is slow or getting sloppy, burning tokens, whether to /compact or /clear or start a new chat, wanting to start fresh without losing progress, or asks about Peak Usage, rollover thresholds, checkpoints or skill restoration, even if they do not name this skill."
---

# Peak Usage guide

Every turn re-reads the whole conversation, so stale history costs on every later turn and, past a point, makes the model less precise. The aim is to keep the context holding only what the current task needs, and to move to a fresh session at the right moment without losing the thread.

Use this when the user asks for it, has enabled it in Project instructions, or clearly describes the problem. Offer a checkpoint at most once per natural boundary; repeated nudging is its own waste.

## What you do yourself

Apply these silently while working. They need no permission and prevent most of the waste.

- Search first, then read the relevant line range, not whole files.
- Bound command output (`head`, `--stat`, failing tests only).
- Do not re-read what is already in context unless it changed.
- Batch independent tool calls into one message.
- Send broad exploration to a subagent and ask for the conclusion with `path:line` pointers.
- Point to files and URLs instead of pasting them back.

The reasons, a fuller table and anti-patterns are in [the efficiency playbook](references/efficiency.md). Read it when the user asks how to save usage, or when a task will involve heavy exploration.

## What you can only suggest

Slash commands are the user's to type. When a boundary arrives, say which one fits and why, in one line.

| Situation | Suggest |
| --- | --- |
| Unrelated new task | `/clear` |
| Same task, noisy history, natural break | `/compact` with a focus naming what must survive |
| Substantial work remains and the next phase needs few facts from history | Handoff: `/peakusage:handoff`, then a fresh session |
| Nearly done | Finish in place; a handoff costs more than it saves |
| Blocked on the user's decision or approval | Stay; state in flight does not transfer well |
| Large sources must be compared side by side | Stay, or raise the soft cap (see the research reference) |

## Surfaces and modes

**Claude Code terminal.** With the `autostart` setting on (the default) or after `/peak-usage start`, the plugin watches context and can save a checkpoint and continue in a fresh session on its own (`auto`), or only prepare one (`suggest`). Other commands: `/peak-usage status`, `/peak-usage stop`, `/peak-usage recover`. Change defaults in `/config`.

**Other Claude Code surfaces, such as the desktop app's Code tab.** The plugin cannot safely drive `/clear` and the prompt box there, so it runs in `nudge` mode: it measures context and, at the soft threshold (and once more at the hard one), adds a note to a tool result asking you to hand off. When you see a "Peak Usage:" note, treat it as the user's own setting. At the next safe milestone, save a handoff with the peak-compact skill, then use a session-start tool such as `hand_off_to_session` or `start_session` if you have one, with the handoff as the brief. Otherwise give the user the file path and the resume line. Starting the session may need the user's click; that is expected. Skip the handoff and say why when the task is nearly done, an operation is in flight, or you are waiting on the user.

**Claude chat and Cowork.** Use the preferences in the conversation or Project instructions. Default to suggestion: offer a checkpoint once at a meaningful boundary. In automatic mode, create a downloadable checkpoint when useful so the user can attach it to a new chat. Off disables proactive handoffs.

## Thresholds

| Preference | Default |
| --- | --- |
| Soft checkpoint | Lower of 65% of the usable window and 160,000 occupied tokens. A cap of 0 disables the cap. |
| Hard checkpoint | 85% of the usable window; prioritize reaching a safe checkpoint. |
| Skill restoration | Relevant, allowlist-only, or none. Deny entries take precedence. |

Use these numbers when the host reports measured usage. Without a counter, use cues: a lot of obsolete history, repeated mistakes about earlier decisions, or a host context warning. These are starting points to test against the user's real work, not proven optima.

At a soft checkpoint, look for a natural break (a finished investigation, a test run, a deliverable). At the hard checkpoint, reach a safe checkpoint before reading anything large.

## Making and resuming a handoff

To create one, follow [the handoff instructions](references/handoff.md). To resume, read the handoff, verify the current state of the files before relying on it, and re-invoke earlier skills that still govern the work (a standing mode or preference) at the start, and others only when the next step needs them, all under the restoration policy.

If the user asks why the defaults are what they are, or how to calibrate them, read [the context research](references/context-research.md). Its figures come from third-party papers and vendor documents that were not independently re-checked here; present them as reported, not as settled fact.
