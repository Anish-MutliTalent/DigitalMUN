/**
 * @mun/protocol — AI-assistant & unexpected-application detection rules
 *
 * Rules are matched client-side against the foreground application name and
 * (when disclosed) the window title. The rule set is stored on the server and
 * synced to clients, so new AI services can be added at runtime WITHOUT
 * recompiling the desktop application (a hard requirement).
 *
 * Matching is intentionally conservative: a rule matches only if its pattern
 * matches the appName OR (when a title is available) the title. Rules never
 * cause content capture beyond what the monitoring event already carries.
 */

import type { Severity } from './models.js';

export type RulePlatform = 'windows' | 'macos' | 'all';

/**
 * How a rule pattern is interpreted.
 *  - contains : case-insensitive substring match
 *  - equals   : case-insensitive exact match
 *  - regex    : regular expression (anchored by the matcher as needed)
 */
export type RulePatternType = 'contains' | 'equals' | 'regex';

/** Which field(s) the rule pattern is tested against. */
export type RuleMatchField = 'app' | 'title' | 'app_or_title';

export interface AiDetectionRule {
  id: string;
  /** Human-readable label, e.g. "ChatGPT". */
  name: string;
  /** Which platform the rule applies to. */
  platform: RulePlatform;
  /** Which field to test. */
  matchField: RuleMatchField;
  patternType: RulePatternType;
  /** The pattern string (regex source when patternType === 'regex'). */
  pattern: string;
  /** Whether the rule is active. */
  enabled: boolean;
  /** Severity raised when this rule matches. */
  severity: Severity;
  /** Free-form category, e.g. "ai_assistant". */
  category: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Result of evaluating rules against the current foreground state.
 */
export interface RuleMatchResult {
  rule: AiDetectionRule;
  matchedOn: 'app' | 'title';
}

/**
 * Built-in seed rules for the major AI assistants. These are loaded into the
 * database by the seed script and can be edited by admins at runtime. Patterns
 * target both browser titles (e.g. "ChatGPT") and desktop app/process names
 * (e.g. "Claude.exe", "ChatGPT.exe").
 *
 * NOTE: window titles for browser tabs typically include the page title, so a
 * title contains-match like "ChatGPT" catches the web app in Chrome/Edge/Safari.
 */
export const BUILTIN_AI_RULES: ReadonlyArray<Omit<AiDetectionRule, 'id' | 'createdAt' | 'updatedAt'>> = [
  {
    name: 'ChatGPT',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'chatgpt',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'OpenAI Playground',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'openai',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'Claude',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'claude',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'Anthropic Console',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'anthropic',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'Google Gemini',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'gemini',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'Microsoft Copilot',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'copilot',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'DeepSeek',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'deepseek',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'Perplexity',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'perplexity',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'Grok / xAI',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'grok',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'xAI',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'x.ai',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'Meta AI',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'meta ai',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
  {
    name: 'Mistral Le Chat',
    platform: 'all',
    matchField: 'app_or_title',
    patternType: 'contains',
    pattern: 'le chat',
    enabled: true,
    severity: 'critical',
    category: 'ai_assistant',
  },
];

/**
 * Apps that are always allowed (never flagged) regardless of rules.
 * MUN Guardian itself, plus common neutral OS chrome. Keep this short and
 * conservative; the chair can still see focus changes to other apps.
 */
export const ALLOWLIST_APP_NAMES: ReadonlyArray<string> = [
  'mun guardian',
  'mun-guardian',
  'explorer.exe',
  'windows input experience',
  'searchhost.exe',
  'startmenuexperiencehost.exe',
  'dock',
  'finder',
  'systemuiserver',
  'controlcenter',
];

/**
 * Pure rule matcher shared by the desktop client and (for verification) the
 * server. Returns the first matching enabled rule (highest severity first is
 * the caller's responsibility — here we return the first match in array order,
 * so the seed list should be ordered by priority).
 */
export function matchRules(
  rules: ReadonlyArray<AiDetectionRule>,
  platform: RulePlatform,
  appName: string | null,
  title: string | null,
): RuleMatchResult | null {
  if (!appName && !title) return null;
  const app = (appName ?? '').toLowerCase();
  const ttl = (title ?? '').toLowerCase();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.platform !== 'all' && rule.platform !== platform) continue;
    const field = rule.matchField;
    const testApp = field === 'app' || field === 'app_or_title';
    const testTitle = field === 'title' || field === 'app_or_title';
    if (testApp && matches(rule, app)) return { rule, matchedOn: 'app' };
    if (testTitle && matches(rule, ttl)) return { rule, matchedOn: 'title' };
  }
  return null;
}

function matches(rule: AiDetectionRule, value: string): boolean {
  if (!value) return false;
  switch (rule.patternType) {
    case 'contains':
      return value.includes(rule.pattern.toLowerCase());
    case 'equals':
      return value === rule.pattern.toLowerCase();
    case 'regex':
      try {
        return new RegExp(rule.pattern, 'i').test(value);
      } catch {
        return false;
      }
  }
}
