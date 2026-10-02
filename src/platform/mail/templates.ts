export interface Rendered {
  subject: string;
  text: string;
}

export function signInCode(code: string): Rendered {
  return {
    subject: 'Your CAN sign-in code',
    text: `Your CAN sign-in code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email.`,
  };
}

/** ISO date (UTC). Email has no ICU runtime, so dates are never localised here. */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const FOOT = 'Nothing from your problem is copied into this email.';

/** Link to the owner page only. No secret, no token, no problem text. */
const body = (link: string, ...lines: string[]) =>
  [...lines, `Open it here: ${link}`, FOOT].join('\n\n');

/** Decision emails never carry the problem text, hints, recommendations or reviewer identities (REVIEW-1). */
export interface DecisionMail {
  /** {appBaseUrl}/me/problems/{id} */
  link: string;
}

export function inReview(m: DecisionMail): Rendered {
  return {
    subject: 'Your problem is in volunteer review',
    text: body(
      m.link,
      'Your problem is now in volunteer review. Volunteers will suggest changes, and you decide what to accept.',
    ),
  };
}

export function waitingForCheck(m: DecisionMail): Rendered {
  return {
    subject: 'Your problem is waiting for the check',
    text: body(
      m.link,
      'The check on your problem could not finish yet, so it is on hold. Nothing was decided about it. The check will be tried again.',
    ),
  };
}

export function changesRequested(m: DecisionMail): Rendered {
  return {
    subject: 'Changes are requested on your problem',
    text: body(
      m.link,
      'The publication check asks for changes before your problem can be published. The hints are shown beside the fields.',
    ),
  };
}

export function published(m: DecisionMail): Rendered {
  return {
    subject: 'Your problem is published',
    text: body(m.link, 'Your problem passed the check and is now public.'),
  };
}

export function notAccepted(
  m: DecisionMail & { deletionDate: Date; appealableUntil: Date },
): Rendered {
  return {
    subject: 'Your problem was not accepted',
    text: body(
      m.link,
      'Your problem was not accepted. The reason is shown on the page.',
      `Your text is deleted on ${formatDate(m.deletionDate)}.`,
      `You can appeal until ${formatDate(m.appealableUntil)}.`,
    ),
  };
}

export function appealOutcome(
  m: DecisionMail & { outcome: 'upheld' | 'overturned' },
): Rendered {
  return {
    subject: 'The outcome of your appeal',
    text: body(
      m.link,
      m.outcome === 'overturned'
        ? 'Your appeal succeeded. The earlier decision was reversed.'
        : 'Your appeal was reviewed and the earlier decision stands.',
    ),
  };
}

export function revisionReminder(
  m: DecisionMail & { withdrawOn: Date },
): Rendered {
  return {
    subject: 'Your problem still needs changes',
    text: body(
      m.link,
      `Your problem is still waiting for your changes. It is withdrawn on ${formatDate(m.withdrawOn)} if nothing changes.`,
    ),
  };
}

/** REMOD-NOTICE-1 */
export function reReviewed(
  m: DecisionMail & { policyVersion: string },
): Rendered {
  return {
    subject: 'Your problem was checked again',
    text: body(
      m.link,
      `Your problem was checked again under policy version ${m.policyVersion}. Nothing was removed silently. If you disagree with the result you can appeal from the page.`,
    ),
  };
}

/** T20 and T21 (D-59) */
export function reopened(
  m: DecisionMail & { policyVersion: string },
): Rendered {
  return {
    subject: 'Your problem was reopened',
    text: body(
      m.link,
      `A rule change under policy version ${m.policyVersion} reopened your problem. It is active again.`,
    ),
  };
}
