import { isTaskViewPropertyId, type MobileCanonicalTask, type MobileWorkspaceSnapshot, type TaskViewPropertyId, type ViewBlock } from "@stash/domain-types";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { stashTheme } from "@/theme/theme";
import {
  displayCollectionPropertyValue,
  displayReadableValue,
  groupReadableRecords,
  matchesReadableFilter,
  readablePresentationName,
  readableTaskGroup,
  visibleNoteTree,
} from "./workspace-reader-model";

type Section = "notes" | "tasks" | "search" | "views";

const colors = {
  label: stashTheme.colors.ink,
  secondaryLabel: stashTheme.colors.secondaryInk,
  separator: stashTheme.colors.rule,
  background: stashTheme.colors.surface,
  accent: stashTheme.colors.accent,
  buttonText: stashTheme.colors.accentContrast,
};

export interface WorkspaceReaderProps {
  snapshot: MobileWorkspaceSnapshot;
  pendingTaskIds: ReadonlySet<string>;
  onUpdateTaskStatus(task: MobileCanonicalTask, statusId: string): Promise<void>;
}

export function WorkspaceReader({ snapshot, pendingTaskIds, onUpdateTaskStatus }: WorkspaceReaderProps) {
  const [section, setSection] = useState<Section>("notes");
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? snapshot.search.filter(({ title, excerpt }) => `${title} ${excerpt ?? ""}`.toLocaleLowerCase().includes(needle)) : [];
  }, [query, snapshot.search]);

  return <View style={{ gap: stashTheme.spacing.lg }}>
    <View accessibilityRole="tablist" accessibilityLabel="Workspace navigation"
      style={{ flexDirection: "row", flexWrap: "wrap", gap: stashTheme.spacing.xs }}>
      {(["notes", "tasks", "search", "views"] as const).map((value) => {
        const label = value.replace(/^./, (letter) => letter.toLocaleUpperCase());
        return <Pressable key={value}
        accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: section === value }} onPress={() => setSection(value)}
        style={{ minWidth: 64, minHeight: stashTheme.controlHeight, justifyContent: "center", paddingHorizontal: stashTheme.spacing.md,
          borderRadius: 999, backgroundColor: section === value ? colors.accent : colors.background, flexGrow: 1, flexShrink: 0, alignItems: "center" }}>
        <Text style={{ color: section === value ? colors.buttonText : colors.label, fontWeight: "600" }}>{label}</Text>
      </Pressable>; })}
    </View>

    {section === "notes" ? <NoteTree snapshot={snapshot} /> : null}
    {section === "tasks" ? <TaskList snapshot={snapshot} pendingTaskIds={pendingTaskIds} onUpdateTaskStatus={onUpdateTaskStatus} /> : null}
    {section === "search" ? <View style={{ gap: stashTheme.spacing.md }}>
      <TextInput accessibilityLabel="Search cached Workspace" value={query} onChangeText={setQuery}
        placeholder="Search Notes, Tasks, and Collections" placeholderTextColor={colors.secondaryLabel}
        style={{ minHeight: stashTheme.controlHeight, borderWidth: 1, borderColor: colors.separator,
          color: colors.label, backgroundColor: colors.background, borderRadius: stashTheme.radius.control,
          borderCurve: "continuous", paddingHorizontal: stashTheme.spacing.md, fontSize: stashTheme.type.body }} />
      {!query.trim() ? <Empty text="Search the Workspace cached on this device." /> : results.length
        ? results.map((result) => <View key={`${result.kind}-${result.id}`} style={cardStyle}>
          <Text selectable style={{ color: colors.secondaryLabel, textTransform: "capitalize" }}>{result.kind}</Text>
          <Text selectable style={{ color: colors.label, fontSize: 17, fontWeight: "600" }}>{result.title}</Text>
          {result.excerpt ? <Text selectable style={{ color: colors.secondaryLabel, lineHeight: 21 }}>{result.excerpt}</Text> : null}
        </View>) : <Empty text="No cached results match this search." />}
    </View> : null}
    {section === "views" ? <ReadableViews views={snapshot.viewBlocks} snapshot={snapshot} /> : null}
  </View>;
}

function NoteTree({ snapshot }: { snapshot: MobileWorkspaceSnapshot }) {
  const notes = new Map(snapshot.notes.map((note) => [note.id, note]));
  const [activeId, setActiveId] = useState(snapshot.noteTree[0]?.id);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const active = activeId ? notes.get(activeId) : undefined;
  return <View style={{ gap: stashTheme.spacing.sm }}>
    {snapshot.noteTree.length ? visibleNoteTree(snapshot.noteTree, collapsed).map((node) => {
      const depth = ancestors(node.id, snapshot).length;
      const isCollapsed = collapsed.has(node.id);
      return <View key={node.id} style={{ flexDirection: "row", gap: stashTheme.spacing.sm, marginLeft: Math.min(depth, 3) * stashTheme.spacing.md }}>
        {node.childCount ? <Pressable accessibilityRole="button" accessibilityLabel={`${isCollapsed ? "Expand" : "Collapse"} ${node.title}`}
          accessibilityState={{ expanded: !isCollapsed }} onPress={() => setCollapsed((current) => {
            const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next;
          })} style={{ minWidth: stashTheme.controlHeight, minHeight: stashTheme.controlHeight, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: colors.accent, fontSize: 18 }}>{isCollapsed ? "+" : "−"}</Text>
        </Pressable> : <View style={{ width: stashTheme.controlHeight }} />}
        <Pressable accessibilityRole="button" accessibilityLabel={`Open Note ${node.title}`} accessibilityState={{ selected: activeId === node.id }}
          onPress={() => setActiveId(node.id)} style={{ flex: 1, minHeight: stashTheme.controlHeight, justifyContent: "center",
            paddingHorizontal: stashTheme.spacing.md, borderRadius: stashTheme.radius.control, borderCurve: "continuous",
            backgroundColor: activeId === node.id ? colors.background : "transparent" }}>
          <Text selectable style={{ color: colors.label, fontSize: 17, fontWeight: activeId === node.id ? "700" : "500" }}>{node.title}</Text>
        </Pressable>
      </View>;
    }) : <Empty text="No Notes are cached yet." />}
    {active ? <View style={cardStyle}>
      <Text selectable accessibilityRole="header" style={{ color: colors.label, fontSize: 19, fontWeight: "700" }}>{active.title}</Text>
      <Text selectable style={{ color: colors.label, lineHeight: 22 }}>{active.content || "No content yet."}</Text>
    </View> : null}
  </View>;
}

function TaskList({ snapshot, pendingTaskIds, onUpdateTaskStatus }: WorkspaceReaderProps) {
  return <View style={{ gap: stashTheme.spacing.md }}>
    {snapshot.tasks.length ? snapshot.tasks.map((task) => <View key={task.id} style={cardStyle}>
      <View style={{ gap: stashTheme.spacing.xs }}>
        <Text selectable accessibilityRole="header" style={{ color: colors.label, fontSize: 18, fontWeight: "700" }}>{task.title}</Text>
        <Text selectable style={{ color: colors.secondaryLabel }}>{task.status.name}{pendingTaskIds.has(task.id) ? " · waiting to synchronize" : ""}</Text>
        {task.projectKeys.length ? <Text selectable style={{ color: colors.secondaryLabel }}>{task.projectKeys.map(({ key }) => key).join(" · ")}</Text> : null}
        {task.description ? <Text selectable style={{ color: colors.label, lineHeight: 21 }}>{task.description}</Text> : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: stashTheme.spacing.sm }}>
        {snapshot.workflow.statuses.map((status) => <Pressable key={status.id} accessibilityRole="button"
          accessibilityLabel={`Set ${task.title} status to ${status.name}`} disabled={status.id === task.status.id}
          onPress={() => void onUpdateTaskStatus(task, status.id)} style={{ minHeight: stashTheme.controlHeight, justifyContent: "center",
            paddingHorizontal: stashTheme.spacing.md, borderRadius: stashTheme.radius.control, borderCurve: "continuous",
            borderWidth: 1, borderColor: status.id === task.status.id ? colors.accent : colors.separator,
            backgroundColor: colors.background }}>
          <Text style={{ color: colors.label, fontWeight: status.id === task.status.id ? "700" : "500" }}>{status.name}</Text>
        </Pressable>)}
      </ScrollView>
    </View>) : <Empty text="No Tasks are cached yet." />}
  </View>;
}

function ReadableViews({ views, snapshot }: { views: ViewBlock[]; snapshot: MobileWorkspaceSnapshot }) {
  return <View style={{ gap: stashTheme.spacing.md }}>
    {views.length ? views.map((view) => {
      const source = view.definition.source;
      const collection = source.kind === "collection" ? snapshot.collections.find(({ id }) => id === source.collectionId) : undefined;
      const sourceNote = collection ? snapshot.notes.find(({ id }) => id === collection.ownerNoteId) : undefined;
      const tasks = source.kind === "tasks" ? snapshot.tasks.filter((task) => view.definition.filters.every((filter) =>
        matchesReadableFilter(taskValue(task, filter.propertyId), filter.operator, filter.value))).sort((left, right) => {
          for (const sort of view.definition.sorts) {
            const compared = displayReadableValue(taskValue(left, sort.propertyId)).localeCompare(displayReadableValue(taskValue(right, sort.propertyId)));
            if (compared) return sort.direction === "ascending" ? compared : -compared;
          }
          return left.title.localeCompare(right.title);
        }) : [];
      const taskGroups = groupTasksForReading(tasks, view.definition.groupBy, snapshot);
      const recordGroups = collection ? groupReadableRecords(collection.records, view.definition, collection.properties) : [];
      const records = recordGroups.flatMap(({ items }) => items);
      const count = source.kind === "tasks" ? tasks.length : records.length;
      const presentation = readablePresentationName(view.definition.presentation);
      const sourceDescription = collection
        ? `${presentation} from ${collection.title}${sourceNote ? ` in ${sourceNote.title}` : ""}`
        : `${presentation} from Workspace Tasks`;
      const itemName = source.kind === "tasks" ? "Task" : "record";
      return <View key={view.id} style={{ gap: stashTheme.spacing.md }}>
        <View style={{ gap: stashTheme.spacing.xs }}>
          <Text selectable accessibilityRole="header" style={{ color: colors.label, fontSize: 20, fontWeight: "700" }}>{view.title}</Text>
          <Text selectable style={{ color: colors.secondaryLabel }}>{sourceDescription}</Text>
          <Text selectable style={{ color: colors.secondaryLabel }}>{count} {itemName}{count === 1 ? "" : "s"}{view.definition.focused ? " · Focused record" : ""}</Text>
        </View>
        {taskGroups.map((group, index) => <View key={group.key ?? `tasks-${index}`} style={{ gap: stashTheme.spacing.sm }}>
          {group.label ? <Text selectable accessibilityRole="header"
            style={{ color: colors.secondaryLabel, fontWeight: "700" }}>{group.label}</Text> : null}
          {group.items.map((task) => <View key={task.id} style={recordStyle}>
            <Text selectable accessibilityRole="header" style={{ color: colors.label, fontSize: 17, fontWeight: "700" }}>{task.title}</Text>
            <Text selectable style={{ color: colors.secondaryLabel }}>{task.status.name} · {task.projectKeys.map(({ key }) => key).join(" · ") || "No Project"}</Text>
          </View>)}
        </View>)}
        {collection && recordGroups.map((group, index) => <View key={group.label ?? `all-${index}`} accessibilityRole="summary" style={{ gap: stashTheme.spacing.sm }}>
          {group.label ? <Text selectable accessibilityRole="header" style={{ color: colors.secondaryLabel, fontWeight: "700" }}>{group.label}</Text> : null}
          {group.items.map((record) => {
            const properties = [...collection.properties].sort((left, right) => left.position - right.position);
            const primary = properties[0];
            const primaryValue = primary ? displayCollectionPropertyValue(primary, record.values[primary.id]) : "";
            return <View key={record.id} style={recordStyle}>
              <Text selectable accessibilityRole="header" style={{ color: colors.label, fontSize: 17, fontWeight: "700" }}>
                {primaryValue || "Untitled record"}
              </Text>
              {properties.map((property) => {
                const value = displayCollectionPropertyValue(property, record.values[property.id]) || "—";
                return <View key={property.id} accessible accessibilityLabel={`${property.name}: ${value}`}
                  style={{ flexDirection: "row", gap: stashTheme.spacing.md, paddingTop: stashTheme.spacing.sm,
                    borderTopWidth: 1, borderTopColor: colors.separator }}>
                  <Text selectable style={{ width: "34%", color: colors.secondaryLabel, fontWeight: "600" }}>{property.name}</Text>
                  <Text selectable style={{ flex: 1, color: colors.label }}>{value}</Text>
                </View>;
              })}
            </View>;
          })}
        </View>)}
        {!count ? <Text selectable style={{ color: colors.secondaryLabel }}>No items match this saved view.</Text> : null}
        <Text selectable style={{ color: colors.secondaryLabel, lineHeight: 21 }}>Change this layout on desktop. Record values stay canonical everywhere.</Text>
      </View>;
    }) : <Empty text="No desktop-authored views are cached yet." />}
  </View>;
}

function groupTasksForReading(tasks: MobileCanonicalTask[], groupBy: string | undefined, snapshot: MobileWorkspaceSnapshot) {
  if (!groupBy || !isTaskViewPropertyId(groupBy)) return [{ key: undefined, label: undefined, items: tasks }];
  const groups = new Map<string, { key: string; label: string; items: MobileCanonicalTask[] }>();
  for (const task of tasks) {
    const presentation = readableTaskGroup(task, groupBy, snapshot.workflow.statuses, snapshot.members);
    const group = groups.get(presentation.key);
    groups.set(presentation.key, { key: presentation.key, label: presentation.label, items: [...(group?.items ?? []), task] });
  }
  return [...groups.values()];
}

function taskValue(task: MobileCanonicalTask, propertyId: string): unknown {
  if (!isTaskViewPropertyId(propertyId)) return undefined;
  return canonicalTaskViewValue(task, propertyId);
}

function canonicalTaskViewValue(task: MobileCanonicalTask, propertyId: TaskViewPropertyId): unknown {
  switch (propertyId) {
    case "task:title": return task.title;
    case "task:description": return task.description;
    case "task:status": return task.status.id;
    case "task:assignee": return task.assigneeIds;
    case "task:project": return task.projectKeys.map(({ key }) => key);
    default: { const exhaustive: never = propertyId; return exhaustive; }
  }
}

function ancestors(id: string, snapshot: MobileWorkspaceSnapshot) {
  const nodes = new Map(snapshot.noteTree.map((node) => [node.id, node]));
  const result: string[] = []; let parent = nodes.get(id)?.parentId;
  while (parent && !result.includes(parent)) { result.push(parent); parent = nodes.get(parent)?.parentId; }
  return result;
}

function Empty({ text }: { text: string }) {
  return <Text selectable style={{ color: colors.secondaryLabel, lineHeight: 22 }}>{text}</Text>;
}

const cardStyle = { gap: stashTheme.spacing.sm, padding: stashTheme.spacing.md, borderRadius: stashTheme.radius.surface,
  borderCurve: "continuous" as const, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.separator };
const recordStyle = cardStyle;
