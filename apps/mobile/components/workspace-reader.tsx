import type { MobileCanonicalTask, MobileWorkspaceSnapshot, ViewBlock } from "@stash/domain-types";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { colors } from "@/theme/colors";

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
  const hidden = (id: string) => ancestors(id, snapshot).some((parentId) => collapsed.has(parentId));
  const active = activeId ? notes.get(activeId) : undefined;
  return <View style={{ gap: 10 }}>
    {snapshot.noteTree.length ? snapshot.noteTree.filter((node) => !hidden(node.id)).map((node) => {
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
        filter.propertyId === "task:status" ? filter.operator !== "equals" || task.status.id === filter.value
          : filter.propertyId !== "task:assignee" || filter.operator !== "equals" || task.assigneeIds.includes(String(filter.value)))) : [];
      const records = collection ? [...collection.records].filter((record) => view.definition.filters.every((filter) => {
        const value = record.values[filter.propertyId]; const empty = value === undefined || value === null || value === "" || Array.isArray(value) && !value.length;
        if (filter.operator === "is_empty") return empty; if (filter.operator === "is_not_empty") return !empty;
        const comparable = displayValue(value).toLocaleLowerCase(); const expected = displayValue(filter.value).toLocaleLowerCase();
        if (filter.operator === "equals") return comparable === expected; if (filter.operator === "not_equals") return comparable !== expected;
        return comparable.includes(expected);
      })).sort((left, right) => {
        for (const sort of view.definition.sorts) {
          const compared = displayValue(left.values[sort.propertyId]).localeCompare(displayValue(right.values[sort.propertyId]));
          if (compared) return sort.direction === "ascending" ? compared : -compared;
        }
        return left.position - right.position;
      }) : [];
      const count = source.kind === "tasks" ? tasks.length : records.length;
      return <View key={view.id} style={cardStyle}>
        <Text selectable accessibilityRole="header" style={{ color: colors.label, fontSize: 17, fontWeight: "700" }}>{view.title}</Text>
        <Text selectable style={{ color: colors.secondaryLabel }}>{view.definition.presentation} view · {count} item{count === 1 ? "" : "s"}</Text>
        {tasks.map((task) => <View key={task.id} style={{ gap: 3, paddingVertical: 7 }}>
          <Text selectable style={{ color: colors.label, fontWeight: "600" }}>{task.title}</Text>
          <Text selectable style={{ color: colors.secondaryLabel }}>{task.status.name} · {task.projectKeys.map(({ key }) => key).join(" · ") || "No Project"}</Text>
        </View>)}
        {collection && records.map((record) => <View key={record.id} style={{ gap: 3, paddingVertical: 7 }}>
          {collection.properties.map((property) => <Text selectable key={property.id} style={{ color: colors.label }}>
            <Text style={{ fontWeight: "600" }}>{property.name}: </Text>{displayValue(record.values[property.id]) || "—"}
          </Text>)}
        </View>)}
        {!count ? <Text selectable style={{ color: colors.secondaryLabel }}>No items match this saved view.</Text> : null}
        <Text selectable style={{ color: colors.secondaryLabel, lineHeight: 21 }}>Layout authoring remains on desktop.</Text>
      </View>;
    }) : <Empty text="No desktop-authored views are cached yet." />}
  </View>;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((entry) => typeof entry === "object" && entry && "fallback" in entry ? String(entry.fallback) : String(entry)).join(", ");
  if (typeof value === "object" && "start" in value) return String(value.start);
  return "";
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
