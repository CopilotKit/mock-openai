import { generateId } from "./helpers.js";
import type { Fixture, FixtureMatch, JournalEntry } from "./types.js";

/**
 * Compare two field values, handling RegExp by source+flags rather than reference.
 */
function fieldEqual(a: unknown, b: unknown): boolean {
  if (a instanceof RegExp && b instanceof RegExp)
    return a.source === b.source && a.flags === b.flags;
  return a === b;
}

/**
 * Check whether two fixture match objects have the same criteria
 * (ignoring sequenceIndex). Used to group sequenced fixtures.
 */
function matchCriteriaEqual(a: FixtureMatch, b: FixtureMatch): boolean {
  return (
    fieldEqual(a.userMessage, b.userMessage) &&
    fieldEqual(a.inputText, b.inputText) &&
    fieldEqual(a.toolCallId, b.toolCallId) &&
    fieldEqual(a.toolName, b.toolName) &&
    fieldEqual(a.model, b.model) &&
    fieldEqual(a.responseFormat, b.responseFormat) &&
    fieldEqual(a.predicate, b.predicate)
  );
}

export class Journal {
  private entries: JournalEntry[] = [];
  readonly fixtureMatchCounts: Map<Fixture, number> = new Map();

  add(entry: Omit<JournalEntry, "id" | "timestamp">): JournalEntry {
    const full: JournalEntry = {
      id: generateId("req"),
      timestamp: Date.now(),
      ...entry,
    };
    this.entries.push(full);
    return full;
  }

  getAll(opts?: { limit?: number }): JournalEntry[] {
    if (opts?.limit !== undefined) {
      return this.entries.slice(-opts.limit);
    }
    return this.entries.slice();
  }

  getLast(): JournalEntry | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
  }

  findByFixture(fixture: Fixture): JournalEntry[] {
    return this.entries.filter((e) => e.response.fixture === fixture);
  }

  getFixtureMatchCount(fixture: Fixture): number {
    return this.fixtureMatchCounts.get(fixture) ?? 0;
  }

  incrementFixtureMatchCount(fixture: Fixture, allFixtures?: readonly Fixture[]): void {
    this.fixtureMatchCounts.set(fixture, this.getFixtureMatchCount(fixture) + 1);
    // When a sequenced fixture matches, also increment all siblings with matching criteria
    if (fixture.match.sequenceIndex !== undefined && allFixtures) {
      for (const sibling of allFixtures) {
        if (sibling === fixture) continue;
        if (sibling.match.sequenceIndex === undefined) continue;
        if (matchCriteriaEqual(fixture.match, sibling.match)) {
          this.fixtureMatchCounts.set(sibling, this.getFixtureMatchCount(sibling) + 1);
        }
      }
    }
  }

  clearMatchCounts(): void {
    this.fixtureMatchCounts.clear();
  }

  clear(): void {
    this.entries = [];
    this.fixtureMatchCounts.clear();
  }

  get size(): number {
    return this.entries.length;
  }
}
