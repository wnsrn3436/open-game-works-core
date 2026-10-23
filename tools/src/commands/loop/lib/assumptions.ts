/** `records/loops/<run>/assumptions.md` (`game-design` `### assumption`). */

export interface Assumption {
  question: string;
  /** The heading line has `needs human`. */
  needsHuman: boolean;
  /** The `- decision:` line; null when the item has none. */
  decision: string | null;
}

const NEEDS_HUMAN = /\(\s*needs human\s*\)|needs human/g;

/** Items of the file: one per `## ` heading, with the `- decision:` line under it. */
export function assumptionItems(text: string): Assumption[] {
  const items: Assumption[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const heading = line.slice(3);
      items.push({ question: heading.replace(NEEDS_HUMAN, '').trim(), needsHuman: heading.includes('needs human'), decision: null });
      continue;
    }
    const decision = /^\s*-\s+decision:\s*(.*)$/.exec(line);
    const item = items.at(-1);
    if (decision && item && item.decision === null) item.decision = (decision[1] as string).trim();
  }
  return items;
}

/** The loop end record and build report line of each item whose heading line has `needs human`. */
export function needsHumanLines(text: string): string[] {
  return assumptionItems(text)
    .filter((item) => item.needsHuman)
    .map((item) => `needs human: ${item.question} (decision: ${item.decision ?? 'none'})`);
}
