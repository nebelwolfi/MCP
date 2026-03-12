import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readIndex, readTask, ensureBoard } from "./storage.js";
import { createTask, editTask, moveTask, deleteTask, findTasks } from "./operations.js";
import { boardView } from "./views.js";

export const server = new McpServer({ name: "kanban", version: "1.0.0" });

const wrap = (fn: (params: Record<string, unknown>) => Promise<string>) =>
  async (params: Record<string, unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: await fn(params) }] };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  };

server.tool("board_view", "Show the full kanban board with all columns and tasks", {}, wrap(boardView));

server.tool("task_create", "Create a new task", {
  title:       z.string().describe("Task title"),
  column:      z.string().optional().describe("Column (default: first column)"),
  description: z.string().optional().describe("Task description (markdown)"),
  priority:    z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority (default: medium)"),
  assignee:    z.string().optional().describe("Assignee"),
  tags:        z.array(z.string()).optional().describe("Tags/labels"),
  position:    z.number().optional().describe("Position in column (0-indexed)"),
  subtasks:    z.array(z.string()).optional().describe("Initial subtask titles"),
}, wrap(async (p) => {
  const t = await createTask(p as unknown as Parameters<typeof createTask>[0]);
  const subInfo = t.subtasks.length ? ` with ${t.subtasks.length} subtask(s)` : "";
  return `Created task "${t.title}" (${t.id}) in ${t.column}${subInfo}`;
}));

server.tool("task_edit", "Edit an existing task's fields", {
  id:          z.string().describe("Task ID"),
  title:       z.string().optional().describe("New title"),
  description: z.string().optional().describe("New description"),
  priority:    z.enum(["low", "medium", "high", "critical"]).optional().describe("New priority"),
  assignee:    z.string().optional().describe("New assignee"),
  tags:        z.array(z.string()).optional().describe("New tags (replaces existing)"),
}, wrap(async (p) => {
  const { id, ...updates } = p as { id: string } & Record<string, unknown>;
  const t = await editTask(id, updates as Parameters<typeof editTask>[1]);
  return `Updated task "${t.title}" (${t.id})`;
}));

server.tool("task_view", "View a single task's full details including subtasks", {
  id: z.string().describe("Task ID"),
}, wrap(async (p) => {
  const { id } = p as { id: string };
  const index = await readIndex();
  const t = await readTask(id);

  let column = "unknown";
  for (const col of index.columns) {
    if ((index.tasksByColumn[col] ?? []).includes(id)) { column = col; break; }
  }

  let out = `# ${t.title}\n\n- **ID:** ${t.id}\n- **Column:** ${column}\n- **Priority:** ${t.priority}\n`;
  out += `- **Assignee:** ${t.assignee || "_unassigned_"}\n- **Tags:** ${t.tags.length ? t.tags.join(", ") : "_none_"}\n`;
  out += `- **Created:** ${t.created}\n- **Updated:** ${t.updated}\n`;
  if (t.started)   out += `- **Started:** ${t.started}\n`;
  if (t.completed) out += `- **Completed:** ${t.completed}\n`;
  if (t.subtasks?.length) {
    const done = t.subtasks.filter((s) => s.completed).length;
    out += `- **Subtasks:** ${done}/${t.subtasks.length} complete\n`;
  }
  if (t.relations?.length) {
    out += `- **Relations:** ${t.relations.length}\n`;
  }
  if (t.description) out += `\n---\n\n${t.description}`;
  if (t.subtasks?.length) {
    out += `\n\n## Sub-tasks\n\n`;
    for (let i = 0; i < t.subtasks.length; i++) {
      const s = t.subtasks[i];
      out += `${i}. [${s.completed ? "x" : " "}] ${s.text}\n`;
    }
  }
  if (t.relations?.length) {
    out += `\n\n## Relations\n\n`;
    for (let i = 0; i < t.relations.length; i++) {
      const r = t.relations[i];
      out += `${i}. **${r.type}** → ${r.taskId}\n`;
    }
  }
  return out;
}));

server.tool("task_move", "Move a task to a different column", {
  id:       z.string().describe("Task ID"),
  column:   z.string().describe("Destination column"),
  position: z.number().optional().describe("Position in destination column"),
}, wrap(async (p) => {
  const { id, column, position } = p as { id: string; column: string; position?: number };
  const t = await moveTask(id, column, position);
  return `Moved "${t.title}" to ${t.column}`;
}));

server.tool("task_delete", "Delete a task from the board", {
  id: z.string().describe("Task ID"),
}, wrap(async (p) => {
  const { id } = p as { id: string };
  const task = await readTask(id);
  await deleteTask(id);
  return `Deleted task "${task.title}" (${id})`;
}));

server.tool("task_find", "Search and filter tasks", {
  query:    z.string().optional().describe("Search text (title, description, tags)"),
  column:   z.string().optional().describe("Filter by column"),
  assignee: z.string().optional().describe("Filter by assignee"),
  tag:      z.string().optional().describe("Filter by tag"),
  priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Filter by priority"),
}, wrap(async (p) => {
  await ensureBoard();
  const tasks = await findTasks(p as Parameters<typeof findTasks>[0]);
  if (tasks.length === 0) return "No tasks found matching the criteria.";
  let out = `Found ${tasks.length} task(s):\n\n`;
  for (const t of tasks) {
    const tags     = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
    const assignee = t.assignee    ? ` @${t.assignee}` : "";
    out += `- **${t.title}** (${t.id}) — ${t.column} | ${t.priority}${assignee}${tags}\n`;
  }
  return out.trim();
}));

server.tool("task_relation", "Manage task relations: add, remove, or list", {
  id:     z.string().describe("Task ID"),
  action: z.enum(["add", "remove", "list"]).describe("Action to perform"),
  type:   z.string().optional().describe("Relation type (e.g. 'blocks', 'blocked by', 'relates to', 'duplicates')"),
  taskId: z.string().optional().describe("Related task ID (required for add/remove)"),
  index:  z.number().optional().describe("Relation index to remove (0-based, alternative to taskId+type for remove)"),
}, wrap(async (p) => {
  const { id, action, type, taskId, index: idx } = p as {
    id: string; action: "add" | "remove" | "list"; type?: string; taskId?: string; index?: number;
  };
  const task = await readTask(id);
  if (!task.relations) task.relations = [];

  const { writeTask } = await import("./storage.js");

  switch (action) {
    case "list": {
      if (task.relations.length === 0) return `No relations on "${task.title}"`;
      let out = `Relations for "${task.title}":\n\n`;
      for (let i = 0; i < task.relations.length; i++) {
        const r = task.relations[i];
        out += `${i}. [${r.type ? r.type + " " : ""}${r.taskId}]\n`;
      }
      return out.trim();
    }
    case "add": {
      if (!type) throw new Error("type is required for add action");
      if (!taskId) throw new Error("taskId is required for add action");
      task.relations.push({ type, taskId });
      await writeTask(task);
      return `Added relation "[${type ? type + " " : ""}${taskId}]" to "${task.title}"`;
    }
    case "remove": {
      if (idx !== undefined) {
        if (idx < 0 || idx >= task.relations.length)
          throw new Error(`Index ${idx} out of range (0-${task.relations.length - 1})`);
        const removed = task.relations.splice(idx, 1)[0];
        await writeTask(task);
        return `Removed relation "[${removed.type ? removed.type + " " : ""}${removed.taskId}]" from "${task.title}"`;
      }
      if (!taskId) throw new Error("taskId or index is required for remove action");
      const before = task.relations.length;
      task.relations = task.relations.filter(
        (r) => !(r.taskId === taskId && (!type || r.type === type))
      );
      if (task.relations.length === before) throw new Error(`No matching relation found`);
      await writeTask(task);
      return `Removed ${before - task.relations.length} relation(s) from "${task.title}"`;
    }
  }
}));

server.tool("task_subtask", "Manage subtasks: add, toggle, or remove", {
  id:     z.string().describe("Task ID"),
  action: z.enum(["add", "toggle", "remove"]).describe("Action to perform"),
  text:   z.string().optional().describe("Subtask text (required for add)"),
  index:  z.number().optional().describe("Subtask index (required for toggle/remove, 0-based)"),
}, wrap(async (p) => {
  const { id, action, text, index: idx } = p as { id: string; action: "add" | "toggle" | "remove"; text?: string; index?: number };
  const task = await readTask(id);
  if (!task.subtasks) task.subtasks = [];

  const { writeTask } = await import("./storage.js");

  switch (action) {
    case "add": {
      if (!text) throw new Error("text is required for add action");
      task.subtasks.push({ text, completed: false });
      await writeTask(task);
      return `Added subtask "${text}" to "${task.title}" (${task.subtasks.length} total)`;
    }
    case "toggle": {
      if (idx === undefined) throw new Error("index is required for toggle action");
      if (idx < 0 || idx >= task.subtasks.length)
        throw new Error(`Index ${idx} out of range (0-${task.subtasks.length - 1})`);
      task.subtasks[idx].completed = !task.subtasks[idx].completed;
      const state = task.subtasks[idx].completed ? "completed" : "incomplete";
      await writeTask(task);
      return `Toggled subtask "${task.subtasks[idx].text}" to ${state}`;
    }
    case "remove": {
      if (idx === undefined) throw new Error("index is required for remove action");
      if (idx < 0 || idx >= task.subtasks.length)
        throw new Error(`Index ${idx} out of range (0-${task.subtasks.length - 1})`);
      const removed = task.subtasks.splice(idx, 1)[0];
      await writeTask(task);
      return `Removed subtask "${removed.text}" from "${task.title}" (${task.subtasks.length} remaining)`;
    }
  }
}));
