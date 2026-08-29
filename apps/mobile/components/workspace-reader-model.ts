import type {
  CollectionProperty,
  CollectionRecord,
  MobileCanonicalTask,
  MobileNoteTreeNode,
  MobileWorkspaceMember,
  MobileCollectionDisplayMetadata,
  MobileWorkspaceWorkflow,
  TaskViewPropertyId,
  ViewFilter,
  ViewPresentation,
  ViewSort,
} from "@stash/domain-types";

export function displayReadableValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((entry) => typeof entry === "object" && entry && "fallback" in entry ? String(entry.fallback) : String(entry)).join(", ");
  if (typeof value === "object" && "fallback" in value) return String(value.fallback);
  if (typeof value === "object" && "start" in value) return String(value.start);
  return "";
}

export function displayCollectionPropertyValue(property: CollectionProperty, value: unknown,
  display: MobileCollectionDisplayMetadata = { members: [], attachments: [] }): string {
  if (property.type === "single_select" || property.type === "multi_select") {
    const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return values.map((entry) => property.options.find(({ id }) => id === entry)?.name ?? displayReadableValue(entry)).join(", ");
  }
  if (property.type === "person" || property.type === "attachment") {
    const options = property.type === "person" ? display.members : display.attachments;
    const unavailable = property.type === "person" ? "Unavailable Member" : "Unavailable file";
    return (Array.isArray(value) ? value : []).map((entry) =>
      options.find(({ id }) => id === entry)?.label ?? unavailable).join(", ");
  }
  return displayReadableValue(value);
}

export function readablePresentationName(presentation: ViewPresentation): string {
  return ({ table: "Table", board: "Board", list: "List", calendar: "Calendar" } as const)[presentation];
}

export function matchesReadableFilter(value: unknown, operator: ViewFilter["operator"], expected: unknown) {
  const empty = value === undefined || value === null || value === "" || Array.isArray(value) && !value.length;
  if (operator === "is_empty") return empty;
  if (operator === "is_not_empty") return !empty;
  const comparable = displayReadableValue(value).toLocaleLowerCase();
  const target = displayReadableValue(expected).toLocaleLowerCase();
  if (operator === "equals") return Array.isArray(value) ? value.map(displayReadableValue).some((entry) => entry.toLocaleLowerCase() === target) : comparable === target;
  if (operator === "not_equals") return Array.isArray(value) ? value.map(displayReadableValue).every((entry) => entry.toLocaleLowerCase() !== target) : comparable !== target;
  return comparable.includes(target);
}

export function visibleNoteTree(nodes: readonly MobileNoteTreeNode[], collapsed: ReadonlySet<string>) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    const visited = new Set<string>(); let parent = node.parentId;
    while (parent && !visited.has(parent)) {
      if (collapsed.has(parent)) return false;
      visited.add(parent); parent = byId.get(parent)?.parentId;
    }
    return true;
  });
}

export function groupReadableRecords(records: readonly CollectionRecord[], definition: {
  filters: readonly ViewFilter[]; sorts: readonly ViewSort[]; groupBy?: string; focused?: { readonly recordId: string };
}, properties: readonly CollectionProperty[] = [], display?: MobileCollectionDisplayMetadata) {
  const visible = [...records].filter((record) => (!definition.focused || definition.focused.recordId === record.id)
    && definition.filters.every((filter) =>
    matchesReadableFilter(record.values[filter.propertyId], filter.operator, filter.value))).sort((left, right) => {
      for (const sort of definition.sorts) {
        const compared = displayReadableValue(left.values[sort.propertyId]).localeCompare(displayReadableValue(right.values[sort.propertyId]));
        if (compared) return sort.direction === "ascending" ? compared : -compared;
      }
      return left.position - right.position;
    });
  if (!definition.groupBy) return [{ key: undefined, label: undefined, items: visible }];
  const groupProperty = properties.find(({ id }) => id === definition.groupBy);
  const groups = new Map<string, { label: string; items: CollectionRecord[] }>();
  for (const record of visible) {
    const stored = record.values[definition.groupBy];
    const values = Array.isArray(stored) ? stored.length ? stored : [undefined] : [stored];
    for (const value of values) {
      const raw = groupProperty
        ? displayCollectionPropertyValue(groupProperty, value, display)
        : displayReadableValue(value);
      const label = raw ? raw.replaceAll("_", " ").replace(/^./, (letter) => letter.toLocaleUpperCase()) : "No value";
      const key = value === undefined || value === null || value === ""
        ? "no-value" : typeof value === "object" && "fallback" in value ? String(value.fallback) : JSON.stringify(value);
      const group = groups.get(key);
      groups.set(key, { label, items: [...(group?.items ?? []), record] });
    }
  }
  return [...groups].map(([key, group]) => ({ key, ...group }));
}

export function readableTaskGroup(task: MobileCanonicalTask, propertyId: TaskViewPropertyId,
  statuses: MobileWorkspaceWorkflow["statuses"], members: readonly MobileWorkspaceMember[]): { key: string; label: string } {
  if (propertyId === "task:status") return { key: task.status.id,
    label: statuses.find(({ id }) => id === task.status.id)?.name ?? task.status.name };
  if (propertyId === "task:assignee") {
    const memberIds = [...new Set(task.assigneeIds)].sort();
    const names = memberIds.map((id) => members.find((member) => member.id === id)?.name ?? "Unknown Member");
    return { key: memberIds.join("|"), label: names.join(", ") || "Unassigned" };
  }
  if (propertyId === "task:project") return { key: task.projectKeys.map(({ projectId }) => projectId).sort().join("|"),
    label: task.projectKeys.map(({ key }) => key).join(", ") || "No Project" };
  if (propertyId === "task:title") return { key: task.title, label: task.title };
  return { key: task.description, label: task.description || "No value" };
}
