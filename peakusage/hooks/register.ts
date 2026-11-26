import type { EngineInterface, On } from 'claude-code';
import { getThreshold, readConfig, selectRestoredSkills, type Config } from './controller';
import { buildForkPrompt, normalizeSkillId, parseDecision, renderContinuation, renderHandoff } from './handoff';

// 'nudge' is for surfaces with no terminal (the desktop Code tab, SDK hosts): the plugin only measures and
// asks Claude to hand off, because it cannot safely drive /clear and the prompt box there.
type Mode = 'off' | 'suggest' | 'auto' | 'nudge';
type Turn = { id: string; manual: boolean; tokens?: number; nudged: boolean };
type Stop = { sessionId: string; turnId: string; quiet: boolean };
type Checkpoint = {
  phase: 'suggested' | 'prepared' | 'cleared' | 'seed-attempted' | 'seeded';
  source: string;
  handoff: string;
  skills: string[];
  destination?: string;
};
type Rollover = { source: string; generation: number; ended: boolean };

const MANUAL_SKILL = 'peakusage:handoff';
const PEAK_SKILLS = new Set([MANUAL_SKILL, 'peakusage:peak-compact', 'peakusage:peak-usage-guide', 'handoff', 'peak-compact', 'peak-usage-guide']);
const CHECKPOINT_PREFIX = 'rollover:';
const SUGGESTION_PREFIX = 'suggestion:';
const ACTIVE_AGENTS = new Set(['pending', 'running', 'waiting', 'idle']);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUDGE = 'Peak Usage is near a context threshold. At the next safe milestone, finish the current operation, preserve the exact next step and any pending approval, and yield. If a task is in flight, keep its state intact.';

function assistNudge(tokens: number, window?: number): string {
  const share = window ? ` (${Math.round(tokens / window * 100)}% of the window)` : '';
  return `Peak Usage: this conversation holds about ${tokens.toLocaleString()} tokens${share}, enough that output quality can start to slip. At the next safe milestone (not mid-edit, not while waiting on the user, and not if the task is nearly done), save a handoff with the peak-compact skill and continue in a fresh session. If you have a session-start tool such as hand_off_to_session or start_session, use it with the handoff as the brief; otherwise give the user the file path and the resume line. Say what you are doing in one line.`;
}

function isOwnOrigin(origin: { kind?: string; name?: string } | undefined): boolean {
  return origin?.kind === 'plugin' && origin.name?.split('@')[0] === 'peakusage';
}

function isManualSkill(name?: string): boolean {
  return name !== undefined && PEAK_SKILLS.has(name);
}

function rememberSkill(skills: Set<string>, name: unknown) {
  if (typeof name !== 'string') return;
  const id = normalizeSkillId(name);
  if (!id || isManualSkill(id) || id.startsWith('peakusage:')) return;
  skills.delete(id);
  skills.add(id);
  if (skills.size > 24) skills.delete(skills.values().next().value!);
}

function display(text: string) {
  return { text, isTextDisplayOnly: true as const };
}

function isRecoverable(value: unknown): value is Checkpoint {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<Checkpoint>;
  return typeof record.handoff === 'string' && typeof record.source === 'string' && Array.isArray(record.skills);
}

type State = {
  config: Config;
  observed: Set<string>;
  mode: Mode;
  interactiveTerminal: boolean;
  active?: Turn;
  latest?: Turn;
  stop?: Stop;
  directSkill?: string;
  pendingManual: boolean;
  generation: number;
  rollover?: Rollover;
  seeding?: { destination: string; generation: number; text: string };
  working: boolean;
  windowSize?: number;
  hint: string;
  warned: boolean;
  goalMayBeActive: boolean;
  awaitingBaseline: boolean;
  freshBaseline: number;
  previousAnswer: string;
  checkpointId?: string;
  nudges: number;
};

function pause(state: State, reason?: string) {
  state.generation++;
  if (reason) state.hint = reason;
}

function isCurrent(state: State, expected: number): boolean {
  return state.mode !== 'off' && state.generation === expected && !state.active;
}

async function availableNames($: EngineInterface): Promise<string[]> {
  return (await $.command.list()).map(command => command.name);
}

async function safety($: EngineInterface, state: State, source: string, turn: Turn, expected: number) {
  if (!isCurrent(state, expected)) return 'new input or a session change arrived';
  if (state.goalMayBeActive) return 'an active /goal may still be running';
  if (state.stop?.sessionId !== source || state.stop.turnId !== turn.id) return 'Claude Code did not report background task and schedule state';
  if (!state.stop.quiet) return 'background work, a schedule, or Plan mode is active';

  const [id, info, draft, agents] = await Promise.all([
    $.session.id(), $.session.info(), $.prompt.read(), $.agent.list(),
  ]);
  if (id !== source || !isCurrent(state, expected)) return 'the active conversation changed';
  if (draft.text) return 'the prompt box has an unsent draft';
  if (info.isHosted || info.isWorkspaceRemote || info.dataRules?.length) return 'the session uses a remote workspace or managed data rules';
  if (agents.some(agent => ACTIVE_AGENTS.has(agent.status))) return 'a subagent or teammate is still active';
  if (!info.transcriptPath || !await $.fs.exists(info.transcriptPath)) return 'the previous transcript could not be verified on disk';
  return isCurrent(state, expected) ? null : 'new input arrived';
}

async function notifyOnce($: EngineInterface, state: State, message: string) {
  state.hint = message;
  if (state.warned) return;
  state.warned = true;
  try { await $.ui.toast(`Peak Usage | ${message}`); } catch { /* Status still carries the message. */ }
}

async function saveSuggestion($: EngineInterface, state: State, checkpoint: Checkpoint, reason?: string) {
  await $.store.set(SUGGESTION_PREFIX + checkpoint.source, { ...checkpoint, phase: 'suggested' });
  state.checkpointId = checkpoint.source;
  const details = reason ? ` Rollover deferred because ${reason}.` : '';
  await notifyOnce($, state, `Handoff saved for ${checkpoint.source}.${details} Run /peak-usage recover.`);
}

async function performRollover($: EngineInterface, state: State, source: string, expected: number, checkpoint: Checkpoint) {
  const key = CHECKPOINT_PREFIX + source;
  const claimScript = `${$.plugin.root}/hooks/claim.cjs`;
  let claim;
  try {
    claim = await $.process.run(['node', claimScript, source]);
  } catch {
    await saveSuggestion($, state, checkpoint, 'the local Node.js checkpoint helper was unavailable');
    return;
  }
  if (claim.exitCode === 2) {
    state.hint = 'A handoff for this conversation already exists';
    return;
  }
  if (claim.exitCode !== 0) {
    await saveSuggestion($, state, checkpoint, 'the exclusive local checkpoint could not be created');
    return;
  }
  await $.store.set(key, checkpoint);
  state.checkpointId = source;
  const turn = state.latest;
  if (!turn || await safety($, state, source, turn, expected)) {
    await notifyOnce($, state, 'The session changed before rollover. The handoff is available with /peak-usage recover.');
    return;
  }

  // Claude Code skips this mod's command.run handler when our code calls it.
  // Confirm the clear with the engine's session.end event and the new session ID.
  state.rollover = { source, generation: expected, ended: false };
  const request = state.rollover;
  await $.command.run({ command: 'clear', args: '' });
  const destination = await $.session.id();
  if (!request.ended || destination === source || !ID_PATTERN.test(destination)) {
    await notifyOnce($, state, 'Fresh conversation could not be verified. The handoff is available with /peak-usage recover.');
    return;
  }

  const cleared: Checkpoint = { ...checkpoint, phase: 'cleared', destination };
  await $.store.set(key, cleared);
  state.awaitingBaseline = true;
  if (!isCurrent(state, expected)) return;

  const [available, draft, destinationNow] = await Promise.all([
    availableNames($), $.prompt.read(), $.session.id(),
  ]);
  if (draft.text || destinationNow !== destination || !isCurrent(state, expected)) return;
  const skills = selectRestoredSkills(cleared.skills, cleared.skills, available, state.config);
  await $.store.set(key, { ...cleared, phase: 'seed-attempted' });
  const [beforeSubmit, currentDraft] = await Promise.all([$.session.id(), $.prompt.read()]);
  if (beforeSubmit !== destination || currentDraft.text || !isCurrent(state, expected)) return;

  const text = renderContinuation(cleared.handoff, skills);
  state.seeding = { destination, generation: expected, text };
  const seeded = await $.prompt.submit({ text });
  if (seeded.drop) {
    await notifyOnce($, state, 'Claude Code declined the continuation. The handoff is available with /peak-usage recover.');
    return;
  }
  await $.store.set(key, { ...cleared, phase: 'seeded' });
  state.hint = `Continued from ${source.slice(0, 8)}`;
}

async function consider($: EngineInterface, state: State, turn: Turn, answer: string, expected: number) {
  if (state.working || state.mode === 'off' || state.generation !== expected || state.active) return;
  state.working = true;
  try {
    const usage = await $.session.usage();
    state.windowSize = usage.context.window;
    const tokens = usage.context.tokens;
    if (typeof tokens !== 'number' || tokens <= 0 || state.generation !== expected) return;
    if (state.awaitingBaseline) {
      state.freshBaseline = tokens;
      state.awaitingBaseline = false;
      return;
    }
    const { soft, hard } = getThreshold(state.config, state.windowSize);
    const minimumGrowth = state.freshBaseline ? Math.min(15_000, Math.max(4_000, soft * 0.1)) : 0;
    if (tokens < soft || tokens < state.freshBaseline + minimumGrowth) {
      state.warned = false;
      state.hint = '';
      return;
    }
    const source = await $.session.id();
    if (!ID_PATTERN.test(source)) return;
    const unsafe = state.mode === 'auto' ? await safety($, state, source, turn, expected) : null;
    if (unsafe || state.mode === 'suggest') {
      if (!isCurrent(state, expected) || state.warned) return;
      const [info, draft] = await Promise.all([$.session.info(), $.prompt.read()]);
      if (draft.text || info.isHosted || info.isWorkspaceRemote || info.dataRules?.length) {
        await notifyOnce($, state, `A handoff was deferred. Run /${MANUAL_SKILL} when ready.`);
        return;
      }
    }
    if (state.mode === 'auto' && await $.store.get(CHECKPOINT_PREFIX + source)) {
      state.checkpointId = source;
      await notifyOnce($, state, 'A saved handoff already exists. Run /peak-usage recover.');
      return;
    }

    const finalAnswer = answer.trim().slice(-4_000);
    if (!finalAnswer || finalAnswer === state.previousAnswer) return;
    state.previousAnswer = finalAnswer;
    const available = await availableNames($);
    const candidates = selectRestoredSkills([...state.observed].reverse(), state.observed, available, state.config);
    if (!isCurrent(state, expected)) return;
    const fork = await $.model.fork({
      prompt: buildForkPrompt({ answer: finalAnswer, candidates, skillMode: state.config.skillMode,
        allow: state.config.allow, deny: state.config.deny, hard: tokens >= hard }),
    });
    if (!isCurrent(state, expected)) return;
    const decision = fork.isAnswered ? parseDecision(fork.text) : null;
    if (!decision) {
      await notifyOnce($, state, `The handoff was unavailable or failed validation. Run /${MANUAL_SKILL} if needed.`);
      return;
    }
    if (decision.status !== 'continue') {
      state.hint = `Keeping this conversation open (${decision.status})`;
      return;
    }

    const handoff = await $.session.redact(renderHandoff(decision));
    const skills = selectRestoredSkills(decision.skills ?? [], candidates, available, state.config);
    if (!handoff.trim() || !isCurrent(state, expected)) return;
    const checkpoint: Checkpoint = { phase: 'prepared', source, handoff, skills };
    const finalUnsafe = state.mode === 'auto' ? await safety($, state, source, turn, expected) : null;
    if (!isCurrent(state, expected)) return;
    if (state.mode === 'suggest' || finalUnsafe) await saveSuggestion($, state, checkpoint, finalUnsafe ?? undefined);
    else await performRollover($, state, source, expected, checkpoint);
  } catch {
    await notifyOnce($, state, `Automatic rollover paused. Use /peak-usage recover for a saved handoff or /${MANUAL_SKILL} for a new one.`);
  } finally {
    state.working = false;
    state.rollover = undefined;
    state.seeding = undefined;
  }
}

export function register(on: On, options: Record<string, unknown> = {}) {
  const state: State = {
    config: readConfig(options),
    observed: new Set(),
    mode: 'off',
    interactiveTerminal: false,
    pendingManual: false,
    generation: 0,
    working: false,
    hint: '',
    warned: false,
    goalMayBeActive: false,
    awaitingBaseline: false,
    freshBaseline: 0,
    previousAnswer: '',
    nudges: 0,
  };

  on('session.start', async ($, event, next) => {
    state.interactiveTerminal = event.isInteractive && event.surface === 'terminal';
    if (state.config.autostart && state.mode === 'off') state.mode = state.interactiveTerminal ? state.config.mode : 'nudge';
    await $.command.register({
      name: 'peak-usage',
      description: 'Start, pause, or inspect Peak Usage context management',
      argumentHint: 'start [auto|suggest] | stop | status | recover [session-id]',
    });
    return next(event);
  });

  on('command.run', async ($, event, next) => {
    if (event.command === 'clear' && isOwnOrigin(event.origin)) {
      const request = state.rollover;
      if (!request || event.args !== '' || state.mode !== 'auto' || !state.latest) {
        return display('Peak Usage kept the original conversation open.');
      }
      try {
        if (await safety($, state, request.source, state.latest, request.generation)) {
          return display('Peak Usage kept the original conversation open.');
        }
      } catch {
        return display('Peak Usage could not verify that the conversation was safe to clear.');
      }
      return next(event);
    }

    const statusOnly = event.command === 'peak-usage' && /^(?:status)?$/.test(event.args.trim());
    if (!statusOnly && !isOwnOrigin(event.origin)) {
      pause(state);
      state.pendingManual = isManualSkill(event.command);
      state.directSkill = event.origin.kind === 'composer' ? event.command : undefined;
      if (event.command === 'goal' && event.args.trim()) {
        state.goalMayBeActive = !/^(clear|stop|off|reset|none|cancel)$/i.test(event.args.trim());
      }
      if (event.command === 'model') state.windowSize = undefined;
    }
    if (event.command !== 'peak-usage') return next(event);

    const [action = 'status', argument, extra] = event.args.trim().split(/\s+/).filter(Boolean);
    if (action === 'start' && !extra && (!argument || argument === 'auto' || argument === 'suggest')) {
      state.mode = !state.interactiveTerminal ? 'nudge' : argument === 'auto' || argument === 'suggest' ? argument : state.config.mode;
      state.hint = '';
      state.warned = false;
      state.previousAnswer = '';
      state.nudges = 0;
      return display(`Peak Usage is active in ${state.mode} mode for this conversation.`);
    }
    if (action === 'stop' && !argument) {
      state.mode = 'off';
      return display('Peak Usage monitoring paused.');
    }
    if (action === 'recover' && !extra) {
      const source = argument || state.checkpointId || await $.session.id();
      if (!ID_PATTERN.test(source)) return display('Use /peak-usage recover with the previous session UUID.');
      const record = await $.store.get(CHECKPOINT_PREFIX + source) ?? await $.store.get(SUGGESTION_PREFIX + source);
      if (!isRecoverable(record)) return display('No handoff was saved for this session.');
      const available = await availableNames($);
      const skills = selectRestoredSkills(record.skills, record.skills, available, state.config);
      return display(renderContinuation(record.handoff, skills));
    }
    if (action === 'status' && !argument) {
      const usage = (await $.session.usage()).context;
      const { soft, hard } = getThreshold(state.config, usage.window);
      const threshold = (n: number) => Number.isFinite(n) ? n.toLocaleString() : 'unknown';
      const lines = [`Peak Usage ${state.mode}. Context ${usage.tokens?.toLocaleString() ?? 'unknown'} tokens.`,
        `Soft ${threshold(soft)} | Hard ${threshold(hard)} | Skills ${state.config.skillMode}`];
      if (state.hint) lines.push(state.hint);
      if (state.checkpointId) lines.push(`Saved handoff session ${state.checkpointId}`);
      return display(lines.join('\n'));
    }
    return display('Use /peak-usage start [auto|suggest], stop, status, or recover [session-id].');
  }).catch(($, event, next) => {
    if (next.called) return;
    return event.command === 'clear' && isOwnOrigin(event.origin)
      ? display('Peak Usage could not verify that the conversation was safe to clear.')
      : next(event);
  });

  on('prompt.submit', async ($, event, next) => {
    const seed = state.seeding;
    if (seed && isOwnOrigin(event.origin)) {
      try {
        const [id, draft] = await Promise.all([$.session.id(), $.prompt.read()]);
        if (id === seed.destination && event.text === seed.text && !draft.text && isCurrent(state, seed.generation)) return next(event);
      } catch { /* Recovery leaves the persisted handoff intact. */ }
      return { drop: 'Peak Usage kept newer input. The handoff is available with /peak-usage recover.' };
    }
    if (!isOwnOrigin(event.origin)) {
      pause(state);
      state.pendingManual ||= isManualSkill(event.command?.name);
    }
    return next(event);
  }).catch(($, event, next) => {
    if (next.called) return;
    return state.seeding && isOwnOrigin(event.origin)
      ? { drop: 'Peak Usage could not verify the fresh conversation. Recover the saved handoff.' }
      : next(event);
  });

  on('session.stop', ($, event, next) => {
    pause(state, 'Claude Code was interrupted');
    return next(event);
  });

  on('session.end', ($, event, next) => {
    const request = state.rollover;
    if (request && request.source === event.sessionId && event.reason === 'clear' && isCurrent(state, request.generation)) {
      request.ended = true;
    } else {
      pause(state, 'The conversation changed');
      state.mode = 'off';
    }
    state.active = undefined;
    state.latest = undefined;
    state.stop = undefined;
    state.observed.clear();
    state.directSkill = undefined;
    state.pendingManual = false;
    state.goalMayBeActive = false;
    state.previousAnswer = '';
    state.warned = false;
    state.freshBaseline = 0;
    state.awaitingBaseline = false;
    state.windowSize = undefined;
    state.nudges = 0;
    return next(event);
  });

  on('turn.start', async ($, event, next) => {
    if (!event.agentId) {
      state.generation++;
      state.active = { id: event.turnId, manual: state.pendingManual, nudged: false };
      state.pendingManual = false;
      state.directSkill = undefined;
      if ((state.mode === 'auto' || state.mode === 'nudge') && !state.windowSize) {
        try { state.windowSize = (await $.session.usage()).context.window; } catch { /* Measurement may arrive later. */ }
      }
    }
    return next(event);
  });

  on('turn.step', async function* ($, event, next) {
    const result = yield* next(event);
    if ((state.mode === 'auto' || state.mode === 'nudge') && !event.agentId && state.active?.id === event.turnId && result.usage) {
      const usage = result.usage;
      state.active.tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
      // A session starts with its tools, skills and instructions already in context; measure growth from there.
      if (state.mode === 'nudge' && !state.freshBaseline) state.freshBaseline = state.active.tokens;
    }
    return result;
  });

  on('tool.call', async ($, event, next) => {
    const turn = state.active;
    const result = await next(event);
    if (!event.agentId && !result.deny && !result.isError && event.tool === 'Skill') {
      if (turn && isManualSkill(event.skill)) turn.manual = true;
      else rememberSkill(state.observed, event.skill);
    }
    if (!turn || turn !== state.active || event.agentId || next.origin?.plugin !== 'engine' ||
        (state.mode !== 'auto' && state.mode !== 'nudge') || turn.manual || turn.nudged || !turn.tokens || result.deny || result.isError) return result;
    const { soft, hard } = getThreshold(state.config, state.windowSize);
    if (turn.tokens < soft) return result;
    if (state.mode === 'nudge') {
      if (turn.tokens < state.freshBaseline + Math.min(15_000, Math.max(4_000, soft * 0.1))) return result;
      // Ask once at the soft threshold and once more at the hard one, so a decision to stay is respected but not forgotten.
      if (state.nudges >= 2 || (state.nudges === 1 && turn.tokens < hard)) return result;
      state.nudges++;
    }
    turn.nudged = true;
    const text = state.mode === 'nudge' ? assistNudge(turn.tokens, state.windowSize) : NUDGE;
    return { ...result, context: [...(result.context ?? []), text] } as typeof result;
  }).catch(($, event, next) => next.called ? undefined : next(event));

  on('skill.prompt', ($, event, next) => {
    const name = event.pluginName && !event.skill.includes(':') ? `${event.pluginName}:${event.skill}` : event.skill;
    if (state.directSkill === name || state.directSkill === event.skill) rememberSkill(state.observed, name);
    return next(event);
  });

  on('classic.Stop', ($, event, next) => {
    const turn = state.active ?? state.latest;
    if (turn) {
      state.stop = { sessionId: event.session_id, turnId: turn.id,
        quiet: Array.isArray(event.background_tasks) && event.background_tasks.length === 0 &&
          Array.isArray(event.session_crons) && event.session_crons.length === 0 &&
          typeof event.permission_mode === 'string' && event.permission_mode !== 'plan' };
    }
    return next(event);
  }).catch(($, event, next) => next.called ? undefined : next(event));

  on('turn.complete', ($, event, next) => {
    if (event.agentId || state.active?.id !== event.turnId) return next(event);
    const turn = state.active;
    state.latest = turn;
    state.active = undefined;
    if (state.mode === 'off' || state.mode === 'nudge' || turn.manual || event.isAborted || (event.reason && event.reason !== 'answer')) return next(event);
    const expected = state.generation;
    $.clock.after(350, () => consider($, state, turn, event.answer, expected));
    return next(event);
  });
}
