export interface BranchImpact {
  descendantCount: number;
  descendants: Array<{ noteId: string; title: string }>;
  collectionCount: number;
  externalLinks: Array<{ noteId: string; title: string; direction: "incoming" | "outgoing" }>;
  projectAccessChanges: Array<{
    noteId: string;
    noteTitle: string;
    projectId: string;
    projectName: string;
    effect: "gained" | "lost";
  }>;
}

const listed = (values: readonly string[]) => values.length ? values.join(", ") : "None";

export function branchImpactConfirmation(heading: string, impact: BranchImpact): string {
  return [
    heading,
    `Descendants (${impact.descendantCount}): ${listed(impact.descendants.map(({ title }) => title))}`,
    `Collections (${impact.collectionCount})`,
    `External links (${impact.externalLinks.length}): ${listed(impact.externalLinks.map(({ direction, title }) => `${direction} ${title}`))}`,
    `Project access changes (${impact.projectAccessChanges.length}): ${listed(impact.projectAccessChanges.map(({ noteTitle, projectName, effect }) =>
      `${noteTitle} ${effect === "gained" ? "gains" : "loses"} ${projectName}`))}`,
  ].join("\n");
}
