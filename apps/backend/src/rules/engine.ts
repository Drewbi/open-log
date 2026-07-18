import fs from "node:fs";
import type { LogRule } from "./types.js";

interface CompiledRule extends LogRule {
  regex: RegExp;
}

export interface RuleMatch {
  rule: LogRule;
  actor: string | null;
  target: string | null;
  summary: string;
}

function buildMatch(rule: LogRule, m: RegExpExecArray): RuleMatch {
  const actor = m.groups?.actor ?? null;
  const target = m.groups?.target ?? null;
  const summary = rule.summaryTemplate
    .replaceAll("{actor}", actor ?? "")
    .replaceAll("{target}", target ?? "");
  return { rule, actor, target, summary };
}

export class RuleEngine {
  private primaryRules: CompiledRule[];
  private fallbackRules: CompiledRule[];

  constructor(rules: LogRule[]) {
    const compiled = rules.map((r) => ({ ...r, regex: new RegExp(r.pattern, r.flags ?? "") }));
    this.primaryRules = compiled
      .filter((r) => !r.requiresKnownActor)
      .sort((a, b) => b.priority - a.priority);
    this.fallbackRules = compiled
      .filter((r) => r.requiresKnownActor)
      .sort((a, b) => b.priority - a.priority);
  }

  static loadFromFiles(defaultPath: string, customPath: string): RuleEngine {
    const defaults = JSON.parse(fs.readFileSync(defaultPath, "utf-8")) as LogRule[];
    let custom: LogRule[] = [];
    if (fs.existsSync(customPath)) {
      const raw = fs.readFileSync(customPath, "utf-8").trim();
      if (raw) custom = JSON.parse(raw) as LogRule[];
    }
    return new RuleEngine([...defaults, ...custom]);
  }

  match(message: string, knownActors: ReadonlySet<string>): RuleMatch | null {
    for (const rule of this.primaryRules) {
      const m = rule.regex.exec(message);
      if (m) return buildMatch(rule, m);
    }
    for (const rule of this.fallbackRules) {
      const m = rule.regex.exec(message);
      if (m && m.groups?.actor && knownActors.has(m.groups.actor)) {
        return buildMatch(rule, m);
      }
    }
    return null;
  }
}
