# Peak Usage for Claude

Peak Usage, Peak Compact, and the Markdown handoff are included in this plugin. In Claude chat or Cowork, open **Customize > Plugins > Add > Upload plugin** and select the ZIP. Choose **Peak Compact** or **Handoff** from the skills menu to create a downloadable Markdown file for the next chat. [Claude plugin setup guide](https://claude.com/docs/plugins/build#test-the-plugin-on-each-surface)

## Claude Code terminal

To load the plugin from disk, extract the archive. Open a terminal in the project where you want to work and point Claude Code at the extracted `peakusage` folder.

```powershell
claude --plugin-dir "C:\path\to\peakusage"
```

Use Claude Code 2.1.332 or later. Automatic rollover uses Node.js on `PATH` to claim the old session once, including when two terminals have opened the same conversation. The manual skill and suggestion mode work without Node.js. With `autostart` on (the default), monitoring begins with every session; set it to `off` to require `/peak-usage start`. Automatic rollover, which clears the session and continues in a fresh one, works only in an interactive terminal. In the desktop app's Code tab and other surfaces without a terminal, Peak Usage runs in `nudge` mode: it measures context and, at the soft threshold and once more at the hard one, asks Claude to save a handoff and start a fresh session with the app's own session tool, which can need one click from you. Manual `/peakusage:handoff` works everywhere. The plugin loads for this launch and waits for opt-in. In the Claude Code terminal, use these commands.

| Command | Behavior |
| --- | --- |
| `/peak-usage start` | Start monitoring the current session, using the configured mode. |
| `/peak-usage start suggest` | Prepare a checkpoint when appropriate and leave the session open. |
| `/peak-usage status` | Show the current mode, context usage and last rollover decision. |
| `/peak-usage stop` | Turn monitoring off for this session. |
| `/peakusage:handoff` | Save `peak-handoff.md` in the current workspace and leave the session open, even while monitoring is off. If the name is taken, use the next available numbered filename. |
| `/peakusage:peak-compact` | Save a Markdown checkpoint using the same handoff workflow. |
| `/peakusage:peak-usage-guide` | Get usage-saving habits (narrow reads, bounded output, subagents, when to `/clear`, `/compact` or hand off) and configuration help. |
| `/peak-usage recover <source-session-id>` | Display a saved automatic checkpoint. Use the source ID reported by Peak Usage. |

The automatic path saves a checkpoint, starts a fresh chat in the same terminal, and continues from that checkpoint. The old chat is still available through `/resume`. A draft, unfinished background work, interruption, or an unavailable safety check can delay the rollover. In a managed installation with limited hooks, use the manual handoff or suggestion mode. A generated checkpoint is kept in Claude Code's local plugin storage for recovery. The next model turn uses the session's normal permissions.

## Settings

Edit Peak Usage settings in Claude Code's `/config`. Stop and start monitoring if you want to select a different mode for the current session. Settings apply to automatic handoffs. Explicit manual handoffs also use the configured skill restoration policy when Claude Code exposes it to the skill.

| Setting | Default | Effect |
| --- | --- | --- |
| Start monitoring automatically | `on` | `off` waits for `/peak-usage start`. |
| Rollover mode | `auto` | `suggest` prepares a checkpoint without clearing. |
| Soft context percentage | `65` | Consider a handoff at the lower of the percentage and the token cap. |
| Soft token cap | `160000` | Set to `0` to disable the absolute cap. |
| Hard context percentage | `85` | Prioritize reaching a safe checkpoint. Set it above the soft percentage. |
| Skill restoration | `relevant` | `allowlist` limits restoration to listed IDs. `none` disables restoration. |
| Skill allowlist and denylist | Empty | Comma-separated skill IDs such as `research` or `docs:edit`. Deny entries take precedence. |

Restore an earlier skill only when the next work needs it. To resume from a saved handoff, open a new session and ask Claude to read the file and continue. The [context research](skills/peak-usage-guide/references/context-research.md) explains the defaults and how to calibrate them.
