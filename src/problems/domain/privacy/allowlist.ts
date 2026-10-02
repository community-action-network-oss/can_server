// Words that mark a capitalised run as an institution, role or place type, never a person.
// Street suffixes are deliberately NOT here: "Elm Street" is handled as an address shape.
export const INSTITUTION_WORDS: ReadonlySet<string> = new Set([
  'Council', 'Department', 'Ministry', 'Office', 'Board', 'Authority', 'Hospital',
  'School', 'Station', 'Committee', 'Commission', 'Agency', 'University', 'Library',
  'Mayor', 'Councillor', 'Minister', 'Senator', 'Governor', 'Director', 'Commissioner',
  'Sheriff', 'Chief', 'Police', 'Fire', 'Water', 'Services', 'Service', 'Park', 'Hall',
]);

// Common sentence openers and calendar words stripped from the front of a capitalised run.
export const LEADING_STOPWORDS: ReadonlySet<string> = new Set([
  'The', 'A', 'An', 'This', 'That', 'These', 'Those', 'Our', 'My', 'Your', 'His', 'Her',
  'Their', 'We', 'They', 'It', 'In', 'On', 'At', 'Of', 'For', 'Please', 'Yesterday',
  'Today', 'Tomorrow', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
  'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December', 'Last', 'Next', 'Every',
]);

export const STREET_SUFFIXES = [
  'street', 'st', 'road', 'rd', 'avenue', 'ave', 'lane', 'drive', 'close', 'way', 'court',
] as const;
