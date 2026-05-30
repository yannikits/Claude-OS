/**
 * Load + validate rule files from a workspace `rules/` directory.
 *
 * Resilient by design (ARCHITECTURE.md §8): one malformed rule file must not
 * disable the whole engine. Parse-errors, schema-errors and duplicate ids are
 * collected per file; valid rules are still returned. A missing directory is
 * not an error — it simply means "no automation configured".
 *
 * One rule per YAML file (the parsed document root is a single Rule object).
 *
 * @module @domains/automation/rule-loader
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { formatErrors } from '../../core/validation/index.js';
import { type Rule, RuleSchema } from './rule-schema.js';

export interface RuleLoadIssue {
  readonly file: string;
  readonly message: string;
}

export interface RuleLoadResult {
  readonly rules: Rule[];
  readonly errors: RuleLoadIssue[];
}

const YAML_EXT = /\.ya?ml$/i;

export function loadRules(rulesDir: string): RuleLoadResult {
  const rules: Rule[] = [];
  const errors: RuleLoadIssue[] = [];

  if (!existsSync(rulesDir)) {
    return { rules, errors };
  }

  // Sort for deterministic "keep first" on duplicate ids.
  const files = readdirSync(rulesDir)
    .filter((f) => YAML_EXT.test(f))
    .sort();
  const seenIds = new Set<string>();

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(join(rulesDir, file), 'utf-8'));
    } catch (err) {
      errors.push({ file, message: `YAML parse error: ${(err as Error).message}` });
      continue;
    }

    const schemaErrors = formatErrors(RuleSchema, parsed);
    if (schemaErrors.length > 0) {
      errors.push({ file, message: schemaErrors.join('; ') });
      continue;
    }

    const rule = parsed as Rule;
    if (seenIds.has(rule.id)) {
      errors.push({ file, message: `Duplicate rule id "${rule.id}" — keeping first occurrence` });
      continue;
    }
    seenIds.add(rule.id);
    rules.push(rule);
  }

  return { rules, errors };
}
