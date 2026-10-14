/** Scenario registry; `all` runs them in this order (auth-probe always first). */
import { askUserQuestion } from './ask-user-question';
import { authProbe } from './auth-probe';
import { clearRename } from './clear-rename';
import type { Scenario } from './common';
import { history } from './history';
import { interrupt } from './interrupt';
import { permissions } from './permissions';
import { permissionsRules } from './permissions-rules';
import { planMode } from './plan-mode';
import { queuePriority } from './queue-priority';
import { resume } from './resume';
import { subagent } from './subagent';

export const SCENARIOS: readonly Scenario[] = [
  authProbe,
  permissions,
  permissionsRules,
  askUserQuestion,
  planMode,
  clearRename,
  queuePriority,
  interrupt,
  subagent,
  resume,
  history,
];

export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.name === name);
}
