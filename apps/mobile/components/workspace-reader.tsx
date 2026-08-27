import { isTaskViewPropertyId, type MobileCanonicalTask, type MobileWorkspaceSnapshot, type TaskViewPropertyId, type ViewBlock } from "@stash/domain-types";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { colors } from "@/theme/colors";
import { displayReadableValue, groupReadableRecords, matchesReadableFilter, visibleNoteTree } from "./workspace-reader-model";

type Section = "notes" | "tasks" | "search" | "views";

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

  return <View style={{ gap: 18 }}>
    <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {(["notes", "tasks", "search", "views"] as const).map((value) => <Pressable key={value}
        accessibilityRole="tab" accessibilityState={{ selected: section === value }} onPress={() => setSection(value)}
        style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 22, borderCurve: "continuous",
          backgroundColor: section === value ? colors.label : colors.background }}>
        <Text style={{ color: section === value ? colors.background : colors.label, fontWeight: "600", textTransform: "capitalize" }}>{value}</Text>
      </Pressable>)}
    </View>

    {section === "notes" ? <NoteTree snapshot={snapshot} /> : null}
    {section === "tasks" ? <TaskList snapshot={snapshot} pendingTaskIds={pendingTaskIds} onUpdateTaskStatus={onUpdateTaskStatus} /> : null}
    {section === "search" ? <View style={{ gap: 12 }}>
      <TextInput accessibilityLabel="Search cached Workspace" value={query} onChangeText={setQuery}
        placeholder="Search Notes, Tasks, and Collections" style={{ minHeight: 48, borderWidth: 1, borderColor: colors.separator,
          color: colors.label, backgroundColor: colors.background, borderRadius: 14, borderCurve: "continuous", paddingHorizontal: 14, fontSize: 16 }} />
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
  return <View style={{ gap: 10 }}>
    {snapshot.noteTree.length ? visibleNoteTree(snapshot.noteTree, collapsed).map((node) => {
      const depth = ancestors(node.id, snapshot).length;
      const isCollapsed = collapsed.has(node.id);
      return <View key={node.id} style={{ flexDirection: "row", gap: 8, marginLeft: Math.min(depth, 3) * 14 }}>
        {node.childCount ? <Pressable accessibilityRole="button" accessibilityLabel={`${isCollapsed ? "Expand" : "Collapse"} ${node.title}`}
          accessibilityState={{ expanded: !isCollapsed }} onPress={() => setCollapsed((current) => {
            const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next;
          })} style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: colors.accent, fontSize: 18 }}>{isCollapsed ? "+" : "−"}</Text>
        </Pressable> : <View style={{ width: 44 }} />}
        <Pressable accessibilityRole="button" accessibilityLabel={`Open Note ${node.title}`} accessibilityState={{ selected: activeId === node.id }}
          onPress={() => setActiveId(node.id)} style={{ flex: 1, minHeight: 44, justifyContent: "center", paddingHorizontal: 12,
            borderRadius: 12, borderCurve: "continuous", backgroundColor: activeId === node.id ? colors.background : "transparent" }}>
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
  return <View style={{ gap: 12 }}>
    {snapshot.tasks.length ? snapshot.tasks.map((task) => <View key={task.id} style={cardStyle}>
      <View style={{ gap: 5 }}>
        <Text selectable accessibilityRole="header" style={{ color: colors.label, fontSize: 18, fontWeight: "700" }}>{task.title}</Text>
        <Text selectable style={{ color: colors.secondaryLabel }}>{task.status.name}{pendingTaskIds.has(task.id) ? " · waiting to synchronize" : ""}</Text>
        {task.projectKeys.length ? <Text selectable style={{ color: colors.secondaryLabel }}>{task.projectKeys.map(({ key }) => key).join(" · ")}</Text> : null}
        {task.description ? <Text selectable style={{ color: colors.label, lineHeight: 21 }}>{task.description}</Text> : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {snapshot.workflow.statuses.map((status) => <Pressable key={status.id} accessibilityRole="button"
          accessibilityLabel={`Set ${task.title} status to ${status.name}`} disabled={status.id === task.status.id}
          onPress={() => void onUpdateTaskStatus(task, status.id)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 13,
            borderRadius: 12, borderCurve: "continuous", borderWidth: 1, borderColor: status.id === task.status.id ? colors.accent : colors.separator,
            backgroundColor: colors.background }}>
          <Text style={{ color: colors.label, fontWeight: status.id === task.status.id ? "700" : "500" }}>{status.name}</Text>
        </Pressable>)}
      </ScrollView>
    </View>) : <Empty text="No Tasks are cached yet." />}
  </View>;
}

function ReadableViews({ views, snapshot }: { views: ViewBlock[]; snapshot: MobileWorkspaceSnapshot }) {
  return <View style={{ gap: 12 }}>
    {views.length ? views.map((view) => {
      const source = view.definition.source;
      const collection = source.kind === "collection" ? snapshot.collections.find(({ id }) => id === source.collectionId) : undefined;
      const tasks = source.kind === "tasks" ? snapshot.tasks.filter((task) => view.definition.filters.every((filter) =>
        matchesReadableFilter(taskValue(task, filter.propertyId), filter.operator, filter.value))).sort((left, right) => {
          for (const sort of view.definition.sorts) {
            const compared = displayReadableValue(taskValue(left, sort.propertyId)).localeCompare(displayReadableValue(taskValue(right, sort.propertyId)));
            if (compared) return sort.direction === "ascending" ? compared : -compared;
          }
          return left.title.localeCompare(right.title);
        }) : [];
      const recordGroups = collection ? groupReadableRecords(collection.records, view.definition) : [];
      const records = recordGroups.flatMap(({ items }) => items);
      const count = source.kind === "tasks" ? tasks.length : records.length;
      return <View key={view.id} style={cardStyle}>
        <Text selectable accessibilityRole="header" style={{ color: colors.label, fontSize: 17, fontWeight: "700" }}>{view.title}</Text>
        <Text selectable style={{ color: colors.secondaryLabel }}>{view.definition.presentation} view · {count} item{count === 1 ? "" : "s"}</Text>
        {tasks.map((task) => <View key={task.id} style={{ gap: 3, paddingVertical: 7 }}>
          {view.definition.groupBy ? <Text selectable style={{ color: colors.secondaryLabel, fontWeight: "600" }}>
            {displayReadableValue(taskValue(task, view.definition.groupBy)) || "No value"}
          </Text> : null}
          <Text selectable style={{ color: colors.label, fontWeight: "600" }}>{task.title}</Text>
          <Text selectable style={{ color: colors.secondaryLabel }}>{task.status.name} · {task.projectKeys.map(({ key }) => key).join(" · ") || "No Project"}</Text>
        </View>)}
        {collection && recordGroups.map((group, index) => <View key={group.label ?? `all-${index}`} accessibilityRole="summary" style={{ gap: 5 }}>
          {group.label ? <Text selectable accessibilityRole="header" style={{ color: colors.secondaryLabel, fontWeight: "700" }}>{group.label}</Text> : null}
          {group.items.map((record) => <View key={record.id} style={{ gap: 3, paddingVertical: 7 }}>
            {collection.properties.map((property) => <Text selectable key={property.id} style={{ color: colors.label }}>
              <Text style={{ fontWeight: "600" }}>{property.name}: </Text>{displayReadableValue(record.values[property.id]) || "—"}
            </Text>)}
          </View>)}
        </View>)}
        {!count ? <Text selectable style={{ color: colors.secondaryLabel }}>No items match this saved view.</Text> : null}
        <Text selectable style={{ color: colors.secondaryLabel, lineHeight: 21 }}>Layout authoring remains on desktop.</Text>
      </View>;
    }) : <Empty text="No desktop-authored views are cached yet." />}
  </View>;
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

const cardStyle = { gap: 10, padding: 16, borderRadius: 18, borderCurve: "continuous" as const,
  backgroundColor: colors.background, borderWidth: 1, borderColor: colors.separator };
