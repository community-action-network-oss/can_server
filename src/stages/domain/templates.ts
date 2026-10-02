// Plan templates (01b 4b.1). Criteria wording is the starting text the poster edits.
import type { Criterion, Stage, StagePlan } from './types.js';

const crit = (id: string, statement: string): Criterion => ({
  id,
  statement,
  measure: 'met_or_not',
});

const stage = (
  id: string,
  name: string,
  goal: string,
  dependsOn: string[],
  needsChoice: boolean,
  criterion: string,
): Stage => ({
  id,
  name,
  goal,
  decisionMethod: 'poster_after_input',
  required: true,
  needsChoice,
  autoStart: true,
  dependsOn,
  criteria: [crit(`${id}-1`, criterion)],
});

export const CLASSIC_5: StagePlan = {
  planVersion: 1,
  stages: [
    stage(
      'facts',
      'Gathering facts',
      'Establish what is known and what is disputed.',
      [],
      false,
      'What is established and what is disputed is summarized, with 1+ evidence URL or a documented missing-evidence note',
    ),
    stage(
      'solutions',
      'Developing solutions',
      'Develop the options.',
      ['facts'],
      true,
      '2+ options, each with mechanism, success metric, risks and verification plan, or 1 option plus a documented "no alternatives" note',
    ),
    stage(
      'choose',
      'Choosing a solution',
      'Choose one option.',
      ['solutions'],
      true,
      'A decision record: chosen option, method, rationale, decider, authority, dissent notes (optional) and a legal-gate record',
    ),
    stage(
      'implement',
      'Doing the work',
      'Carry out the chosen steps.',
      ['choose'],
      false,
      'Every required task done or dropped with a reason',
    ),
    stage(
      'verify',
      'Checking the result',
      'Check the result against the success metric.',
      ['implement'],
      false,
      "Verification evidence matches the chosen option's success metric",
    ),
  ],
  finalCriteria: [
    crit('final-1', 'The problem is solved as the poster described it'),
  ],
};

/** One stage `resolve` whose criteria equal the final criteria. */
export function ONE_STAGE(finalCriteria: Criterion[]): StagePlan {
  return {
    planVersion: 1,
    stages: [
      {
        id: 'resolve',
        name: 'Resolve',
        goal: 'Solve the problem.',
        decisionMethod: 'poster_after_input',
        required: true,
        needsChoice: true,
        autoStart: true,
        dependsOn: [],
        criteria: finalCriteria.map((c) => ({ ...c })),
      },
    ],
    finalCriteria,
  };
}
