import YAML from "yaml";
import type { Frontmatter, Subtask, Relation, Task, BoardIndex } from "./types.js";

export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  content = content.replace(/^\uFEFF/, "");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };

  const lines = match[1].split("\n");
  const fm: Frontmatter = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trimEnd();
    if (!line) { i++; continue; }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === "" && i + 1 < lines.length && /^\s+-/.test(lines[i + 1])) {
      const arr: string[] = [];
      i++;
      while (i < lines.length && /^\s+-/.test(lines[i])) {
        arr.push(lines[i].replace(/^\s+-\s*/, "").trim().replace(/^['"]|['"]$/g, ""));
        i++;
      }
      fm[key] = arr;
      continue;
    }

    const arrMatch = rest.match(/^\[(.*)\]$/);
    if (arrMatch) {
      fm[key] = arrMatch[1]
        ? arrMatch[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)
        : [];
    } else if (/^-?\d+$/.test(rest)) {
      fm[key] = parseInt(rest, 10);
    } else if (/^-?\d+\.\d+$/.test(rest)) {
      fm[key] = parseFloat(rest);
    } else {
      fm[key] = rest.replace(/^['"]|['"]$/g, "");
    }
    i++;
  }

  return { frontmatter: fm, body: match[2].trim() };
}

export function toMarkdown(fm: Frontmatter, body: string): string {
  let yaml = "";
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        yaml += `${key}: []\n`;
      } else {
        yaml += `${key}:\n`;
        for (const item of value) {
          const q = typeof item === "string" && /\s/.test(String(item));
          yaml += q ? `  - '${item}'\n` : `  - ${item}\n`;
        }
      }
    } else {
      yaml += `${key}: ${value}\n`;
    }
  }
  return `---\n${yaml}---\n${body ? "\n" + body + "\n" : ""}`;
}

/** Parse subtasks from standalone subtasks.md (plain checkbox lines, no ## header) */
export function parseSubtasks(content: string): Subtask[] {
  const subtasks: Subtask[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^- \[([ xX])\] (.+)$/);
    if (m) subtasks.push({ text: m[2].trim(), completed: m[1] !== " " });
  }
  return subtasks;
}

/** Parse relations from standalone relations.md (plain relation lines, no ## header) */
export function parseRelations(content: string): Relation[] {
  const relations: Relation[] = [];
  for (const line of content.split("\n")) {
    const linkM = line.match(/^- \[([^\]]+)\]\([^)]+\)$/);
    const bracketM = !linkM && line.match(/^- \[([^\]]+)\]$/);
    const text = linkM ? linkM[1].trim() : bracketM ? bracketM[1].trim() : null;
    if (!text) continue;
    const parts = text.split(" ");
    const type = parts.length > 1 ? parts[0] : "";
    const taskId = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
    relations.push({ type, taskId });
  }
  return relations;
}

export function serializeSubtasks(subtasks: Subtask[]): string {
  if (subtasks.length === 0) return "";
  return subtasks.map((st) => `- [${st.completed ? "x" : " "}] ${st.text}`).join("\n") + "\n";
}

export function serializeRelations(relations: Relation[]): string {
  if (relations.length === 0) return "";
  return relations.map((r) => {
    const label = r.type ? `${r.type} ${r.taskId}` : r.taskId;
    return `- [${label}](${r.taskId}/task.md)`;
  }).join("\n") + "\n";
}

// ── YAML format (v2) ─────────────────────────────────────────────────

export function taskToYaml(task: Task): string {
  const obj: Record<string, unknown> = { title: task.title };

  obj.created = task.created;
  obj.updated = task.updated;
  if (task.started) obj.started = task.started;
  if (task.completed) obj.completed = task.completed;
  if (task.priority && task.priority !== "medium") obj.priority = task.priority;
  if (task.assignee) obj.assignee = task.assignee;
  if (task.tags?.length) obj.tags = task.tags;
  if (task.description) obj.description = task.description;
  if (task.relations?.length) {
    obj.relations = task.relations.map((r) =>
      r.type ? `${r.type} ${r.taskId}` : r.taskId
    );
  }
  if (task.subtasks?.length) {
    obj.subtasks = task.subtasks.map((st) =>
      `[${st.completed ? "x" : " "}] ${st.text}`
    );
  }

  return YAML.stringify(obj, { lineWidth: 0 });
}

export function taskFromYaml(content: string, id: string): Task {
  const obj = YAML.parse(content) ?? {};

  const subtasks: Subtask[] = (obj.subtasks ?? []).map((s: string) => {
    const m = s.match(/^\[([ xX])\] (.+)$/);
    return m
      ? { text: m[2].trim(), completed: m[1] !== " " }
      : { text: s, completed: false };
  });

  const relations: Relation[] = (obj.relations ?? []).map((s: string) => {
    const parts = s.split(" ");
    return parts.length > 1
      ? { type: parts[0], taskId: parts.slice(1).join(" ") }
      : { type: "", taskId: parts[0] };
  });

  return {
    id,
    title: obj.title ?? id,
    description: obj.description ?? "",
    subtasks,
    relations,
    created: obj.created ?? "",
    updated: obj.updated ?? "",
    started: obj.started,
    completed: obj.completed,
    priority: obj.priority ?? "medium",
    assignee: obj.assignee ?? "",
    tags: Array.isArray(obj.tags) ? obj.tags : obj.tags ? [obj.tags] : [],
  };
}

export function indexToYaml(index: BoardIndex): string {
  const obj: Record<string, unknown> = { name: index.name };
  if (index.startedColumns?.length) obj.startedColumns = index.startedColumns;
  if (index.completedColumns?.length) obj.completedColumns = index.completedColumns;

  // columns as ordered map: { columnName: [taskId, ...] }
  const columns: Record<string, string[]> = {};
  for (const col of index.columns) {
    columns[col] = index.tasksByColumn[col] ?? [];
  }
  obj.columns = columns;

  return YAML.stringify(obj, { lineWidth: 0 });
}

export function indexFromYaml(content: string): BoardIndex {
  const obj = YAML.parse(content) ?? {};

  const columns: string[] = [];
  const tasksByColumn: Record<string, string[]> = {};

  if (obj.columns && typeof obj.columns === "object") {
    for (const [col, tasks] of Object.entries(obj.columns)) {
      columns.push(col);
      tasksByColumn[col] = Array.isArray(tasks) ? (tasks as string[]) : [];
    }
  }

  return {
    name: obj.name ?? "",
    columns,
    tasksByColumn,
    startedColumns: Array.isArray(obj.startedColumns) ? obj.startedColumns : [],
    completedColumns: Array.isArray(obj.completedColumns) ? obj.completedColumns : [],
  };
}
