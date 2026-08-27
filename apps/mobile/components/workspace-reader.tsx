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
  return <View style={{ gap: 10 }}>
    {snapshot.noteTree.length ? snapshot.noteTree.map((node) => {
      const note = notes.get(node.id);
      const depth = ancestors(node.id, snapshot).length;
      return <View key={node.id} style={{ ...cardStyle, marginLeft: Math.min(depth, 3) * 14 }}>
        <Text selectable accessibilityRole="header" style={{ color: colors.label, fontSize: 17, fontWeight: "600" }}>{node.title}</Text>
        <Text selectable style={{ color: colors.secondaryLabel, lineHeight: 21 }} numberOfLines={5}>{note?.content || "No content yet."}</Text>
        {node.childCount ? <Text selectable style={{ color: colors.secondaryLabel }}>{node.childCount} child Note{node.childCount === 1 ? "" : "s"}</Text> : null}
      </View>;
    }) : <Empty text="No Notes are cached yet." />}
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
      const count = source.kind === "tasks" ? snapshot.tasks.length
        : snapshot.collections.find(({ id }) => id === source.collectionId)?.records.length ?? 0;
      return <View key={view.id} style={cardStyle}>
        <Text selectable accessibilityRole="header" style={{ color: colors.label, fontSize: 17, fontWeight: "700" }}>{view.title}</Text>
        <Text selectable style={{ color: colors.secondaryLabel }}>{view.definition.presentation} view · {count} item{count === 1 ? "" : "s"}</Text>
        <Text selectable style={{ color: colors.label, lineHeight: 21 }}>This desktop-authored view is available as a readable summary. Editing its layout remains on desktop.</Text>
      </View>;
    }) : <Empty text="No desktop-authored views are cached yet." />}
  </View>;
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
