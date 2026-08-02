/**
 * @mun/desktop — client-side AI-detection rule cache
 *
 * Mirrors the server's rule set (synced on login + on `rules_updated`). The
 * engine matches the foreground app/title against these rules locally so it can
 * set the correct severity + matchedRuleId on the event BEFORE sending it. The
 * server re-derives warnings from the event; matching here keeps the wire
 * payload self-describing and lets the delegate UI show a live "flagged" state.
 */

import { matchRules, type AiDetectionRule, type RuleMatchResult, type RulePlatform } from '@mun/protocol';
import { ALLOWLIST_APP_NAMES } from '@mun/protocol';

class RuleCache {
  private rules: AiDetectionRule[] = [];

  set(rules: AiDetectionRule[]): void {
    this.rules = rules;
  }

  get(): AiDetectionRule[] {
    return this.rules;
  }

  match(platform: RulePlatform, appName: string | null, title: string | null): RuleMatchResult | null {
    return matchRules(this.rules, platform, appName, title);
  }

  isAllowlisted(appName: string | null): boolean {
    if (!appName) return false;
    return ALLOWLIST_APP_NAMES.includes(appName.toLowerCase());
  }
}

export const ruleCache = new RuleCache();
