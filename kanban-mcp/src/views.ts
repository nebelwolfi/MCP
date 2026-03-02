import { boardExists, readIndex, getAllTasksWithColumns, listOrphanedFiles, readTask, ensureBoard } from "./storage.js";

export async function boardView(): Promise<string> {
  await ensureBoard();
  if (!(await boardExists())) return "No board found. Create a task to auto-initialize.";
  const { tasks, index } = await getAllTasksWithColumns();
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

  let out = `# ${index.name}\n\n`;
  for (const col of index.columns) {
    const ids = index.tasksByColumn[col] ?? [];
    out += `## ${col} (${ids.length})\n`;
    if (ids.length === 0) {
      out += "_No tasks_\n\n";
    } else {
      for (const id of ids) {
        const t = byId[id];
        if (!t) { out += `- ~~${id}~~ _(missing file)_\n`; continue; }
        const tags     = t.tags.length  ? ` [${t.tags.join(", ")}]` : "";
        const assignee = t.assignee     ? ` @${t.assignee}` : "";
        const prio     = t.priority !== "medium" ? ` !${t.priority}` : "";
        const subs     = t.subtasks?.length
          ? ` [${t.subtasks.filter((s) => s.completed).length}/${t.subtasks.length}]` : "";
        out += `- **${t.title}** (${t.id})${prio}${subs}${assignee}${tags}\n`;
      }
      out += "\n";
    }
  }
  return out.trim();
}

export async function boardStats(): Promise<string> {
  await ensureBoard();
  if (!(await boardExists())) return "No board found.";
  const { tasks, index } = await getAllTasksWithColumns();
  const total = tasks.length;
  if (total === 0) return "Board is empty.";

  let out = `# Board Stats: ${index.name}\n\n**Total tasks:** ${total}\n\n`;
  out += "| Column | Count | % |\n|--------|------:|---:|\n";
  for (const col of index.columns) {
    const count = tasks.filter((t) => t.column === col).length;
    out += `| ${col} | ${count} | ${Math.round((count / total) * 100)}% |\n`;
  }
  const done = tasks.filter((t) => index.completedColumns.includes(t.column)).length;
  out += `\n**Completion rate:** ${Math.round((done / total) * 100)}%\n`;

  const prios: Record<string, number> = {};
  for (const t of tasks) prios[t.priority] = (prios[t.priority] || 0) + 1;
  out += "\n**By priority:**\n";
  for (const [p, c] of Object.entries(prios).sort()) out += `- ${p}: ${c}\n`;

  const oldest = tasks.reduce((a, b) => (a.created < b.created ? a : b));
  out += `\n**Oldest task:** ${oldest.title} (created ${oldest.created.split("T")[0]})`;
  return out;
}

export async function boardValidate(): Promise<string> {
  await ensureBoard();
  if (!(await boardExists())) return "No board found.";
  const index = await readIndex();
  const issues: string[] = [];

  for (const col of index.columns) {
    for (const id of (index.tasksByColumn[col] ?? [])) {
      try {
        const task = await readTask(id);
        if (!task.title) issues.push(`Task ${id} has no title`);
      } catch (e) {
        issues.push(`Task "${id}" in "${col}" has no file: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const orphans = await listOrphanedFiles();
  for (const f of orphans) issues.push(`Task file "${f}" is not referenced in the index`);

  return issues.length === 0
    ? "Board is valid. No issues found."
    : `Found ${issues.length} issue(s):\n${issues.map((i) => `- ${i}`).join("\n")}`;
}
