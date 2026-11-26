import { normalizeSkillId } from './handoff';

type SkillMode = 'relevant' | 'allowlist' | 'none';

export type Config = {
  mode: 'auto' | 'suggest';
  autostart: boolean;
  softPercent: number;
  softCapTokens: number;
  hardPercent: number;
  skillMode: SkillMode;
  allow: string[];
  deny: string[];
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function skillList(value: unknown): string[] {
  const names = typeof value === 'string' ? value.split(/[\s,]+/) : [];
  return [...new Set(names.map(normalizeSkillId).filter((name): name is string => !!name))];
}

export function readConfig(options: Record<string, unknown>): Config {
  const softPercent = boundedNumber(options.soft_percent, 65, 1, 98);
  const hardPercent = boundedNumber(options.hard_percent, 85, softPercent + 1, 99);
  const skillMode = options.skill_mode;
  return {
    mode: options.mode === 'suggest' ? 'suggest' : 'auto',
    autostart: options.autostart !== 'off',
    softPercent,
    softCapTokens: boundedNumber(options.soft_cap_tokens, 160_000, 0, 10_000_000),
    hardPercent,
    skillMode: skillMode === 'allowlist' || skillMode === 'none' ? skillMode : 'relevant',
    allow: skillList(options.skill_allow),
    deny: skillList(options.skill_deny),
  };
}

export function getThreshold(config: Config, window?: number): { soft: number; hard: number } {
  const validWindow = typeof window === 'number' && Number.isFinite(window) && window > 0;
  const softByWindow = validWindow ? Math.floor(window * config.softPercent / 100) : Infinity;
  return {
    soft: Math.min(softByWindow, config.softCapTokens || Infinity),
    hard: validWindow ? Math.floor(window * config.hardPercent / 100) : Infinity,
  };
}

export function selectRestoredSkills(
  selected: Iterable<string>,
  observed: Iterable<string>,
  available: Iterable<string>,
  config: Config,
): string[] {
  if (config.skillMode === 'none') return [];
  const observedNames = new Set(Array.from(observed, normalizeSkillId));
  const availableNames = new Set(Array.from(available, normalizeSkillId));
  const eligible = Array.from(selected, normalizeSkillId).filter((name): name is string =>
    !!name && name !== 'handoff' && !name.startsWith('peakusage:') &&
    observedNames.has(name) && availableNames.has(name) && !config.deny.includes(name) &&
    (config.skillMode !== 'allowlist' || config.allow.includes(name)),
  );
  return [...new Set(eligible)];
}
