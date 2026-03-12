#!/usr/bin/env node
import { createTask, editTask, moveTask, deleteTask, findTasks } from "./operations.js";
import { boardView, boardStats, boardValidate } from "./views.js";
import { readTask, readIndex, writeTask, ensureBoard } from "./storage.js";
import type { Task } from "./types.js";

const args = process.argv.slice(2);
const cmd = args[0]?.toLowerCase();

function usage(): string {
  return `kanban-cli — command-line interface for kanban-mcp boards

Usage: kanban <command> [options]

Board commands:
  board                        Show the full board
  stats                        Board statistics
  validate                     Check board consistency

Task commands:
  create <title> [options]     Create a new task
    --column <col>             Column (default: first)
    --priority <p>             low | medium | high | critical
    --assignee <name>          Assignee
    --tags <t1,t2,...>         Comma-separated tags
    --description <text>       Task description
  view <id>                    View task details
  edit <id> [options]          Edit task fields
    --title <text>             New title
    --priority <p>             New priority
    --assignee <name>          New assignee
    --tags <t1,t2,...>         New tags (replaces existing)
    --description <text>       New description
  move <id> <column>           Move task to column
    --position <n>             Position in column (0-indexed)
  delete <id>                  Delete a task
  find [query] [options]       Search tasks
    --column <col>             Filter by column
    --assignee <name>          Filter by assignee
    --tag <tag>                Filter by tag
    --priority <p>             Filter by priority

Relation commands:
  relation <id>                List relations
  relation <id> add <type> <targetId>
  relation <id> remove <index>

Subtask commands:
  subtask <id>                 List subtasks
  subtask <id> add <text>
  subtask <id> toggle <index>
  subtask <id> remove <index>

Environment:
  KANBAN_ROOT                  Override working directory for board resolution
                               (board stored at ~/.kanban-boards/<slug>)`;
}

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function positionalArgs(from: number): string[] {
  const result: string[] = [];
  for (let i = from; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    result.push(args[i]);
  }
  return result;
}

async function taskView(id: string): Promise<string> {
  const index = await readIndex();
  const t = await readTask(id);

  let column = "unknown";
  for (const col of index.columns) {
    if ((index.tasksByColumn[col] ?? []).includes(id)) { column = col; break; }
  }

  let out = `# ${t.title}\n\n- ID: ${t.id}\n- Column: ${column}\n- Priority: ${t.priority}\n`;
  out += `- Assignee: ${t.assignee || "(unassigned)"}\n- Tags: ${t.tags.length ? t.tags.join(", ") : "(none)"}\n`;
  out += `- Created: ${t.created}\n- Updated: ${t.updated}\n`;
  if (t.started) out += `- Started: ${t.started}\n`;
  if (t.completed) out += `- Completed: ${t.completed}\n`;
  if (t.subtasks?.length) {
    const done = t.subtasks.filter((s) => s.completed).length;
    out += `- Subtasks: ${done}/${t.subtasks.length} complete\n`;
  }
  if (t.relations?.length) {
    out += `- Relations: ${t.relations.length}\n`;
  }
  if (t.description) out += `\n${t.description}`;
  if (t.subtasks?.length) {
    out += `\n\nSub-tasks:\n`;
    for (let i = 0; i < t.subtasks.length; i++) {
      const s = t.subtasks[i];
      out += `  ${i}. [${s.completed ? "x" : " "}] ${s.text}\n`;
    }
  }
  if (t.relations?.length) {
    out += `\nRelations:\n`;
    for (let i = 0; i < t.relations.length; i++) {
      const r = t.relations[i];
      out += `  ${i}. ${r.type} -> ${r.taskId}\n`;
    }
  }
  return out;
}

async function run(): Promise<void> {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    return;
  }

  switch (cmd) {
    case "board": {
      console.log(await boardView());
      break;
    }
    case "stats": {
      console.log(await boardStats());
      break;
    }
    case "validate": {
      console.log(await boardValidate());
      break;
    }
    case "create": {
      const title = positionalArgs(1).join(" ");
      if (!title) { console.error("Error: title is required"); process.exit(1); }
      const tagsRaw = flag("tags");
      const t = await createTask({
        title,
        column: flag("column"),
        description: flag("description"),
        priority: flag("priority") as Task["priority"] | undefined,
        assignee: flag("assignee"),
        tags: tagsRaw ? tagsRaw.split(",").map((s) => s.trim()) : undefined,
      });
      const subInfo = t.subtasks.length ? ` with ${t.subtasks.length} subtask(s)` : "";
      console.log(`Created "${t.title}" (${t.id}) in ${t.column}${subInfo}`);
      break;
    }
    case "view": {
      const id = args[1];
      if (!id) { console.error("Error: task ID is required"); process.exit(1); }
      console.log(await taskView(id));
      break;
    }
    case "edit": {
      const id = args[1];
      if (!id) { console.error("Error: task ID is required"); process.exit(1); }
      const updates: Record<string, unknown> = {};
      const title = flag("title");
      const description = flag("description");
      const priority = flag("priority");
      const assignee = flag("assignee");
      const tagsRaw = flag("tags");
      if (title) updates.title = title;
      if (description) updates.description = description;
      if (priority) updates.priority = priority;
      if (assignee) updates.assignee = assignee;
      if (tagsRaw) updates.tags = tagsRaw.split(",").map((s) => s.trim());
      if (Object.keys(updates).length === 0) { console.error("Error: no fields to update"); process.exit(1); }
      const t = await editTask(id, updates as Parameters<typeof editTask>[1]);
      console.log(`Updated "${t.title}" (${t.id})`);
      break;
    }
    case "move": {
      const id = args[1];
      const column = positionalArgs(2).join(" ");
      if (!id || !column) { console.error("Error: task ID and column are required"); process.exit(1); }
      const pos = flag("position");
      const t = await moveTask(id, column, pos !== undefined ? parseInt(pos, 10) : undefined);
      console.log(`Moved "${t.title}" to ${t.column}`);
      break;
    }
    case "delete": {
      const id = args[1];
      if (!id) { console.error("Error: task ID is required"); process.exit(1); }
      const task = await readTask(id);
      await deleteTask(id);
      console.log(`Deleted "${task.title}" (${id})`);
      break;
    }
    case "find": {
      await ensureBoard();
      const queryParts = positionalArgs(1);
      const query = queryParts.length ? queryParts.join(" ") : undefined;
      const tasks = await findTasks({
        query,
        column: flag("column"),
        assignee: flag("assignee"),
        tag: flag("tag"),
        priority: flag("priority") as Task["priority"] | undefined,
      });
      if (tasks.length === 0) { console.log("No tasks found."); break; }
      console.log(`Found ${tasks.length} task(s):\n`);
      for (const t of tasks) {
        const tags = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
        const assignee = t.assignee ? ` @${t.assignee}` : "";
        console.log(`  ${t.id}  ${t.title}  (${t.column} | ${t.priority})${assignee}${tags}`);
      }
      break;
    }
    case "relation": {
      const id = args[1];
      if (!id) { console.error("Error: task ID is required"); process.exit(1); }
      const action = args[2]?.toLowerCase();
      const task = await readTask(id);
      if (!task.relations) task.relations = [];

      if (!action || action === "list") {
        if (task.relations.length === 0) { console.log(`No relations on "${task.title}"`); break; }
        console.log(`Relations for "${task.title}":\n`);
        for (let i = 0; i < task.relations.length; i++) {
          const r = task.relations[i];
          console.log(`  ${i}. [${r.type ? r.type + " " : ""}${r.taskId}]`);
        }
      } else if (action === "add") {
        const type = args[3];
        const targetId = args[4];
        if (!type || !targetId) { console.error("Error: type and targetId are required"); process.exit(1); }
        task.relations.push({ type, taskId: targetId });
        await writeTask(task);
        console.log(`Added relation [${type} ${targetId}] to "${task.title}"`);
      } else if (action === "remove") {
        const idx = parseInt(args[3], 10);
        if (isNaN(idx)) { console.error("Error: index is required"); process.exit(1); }
        if (idx < 0 || idx >= task.relations.length) {
          console.error(`Error: index ${idx} out of range (0-${task.relations.length - 1})`);
          process.exit(1);
        }
        const removed = task.relations.splice(idx, 1)[0];
        await writeTask(task);
        console.log(`Removed relation [${removed.type ? removed.type + " " : ""}${removed.taskId}] from "${task.title}"`);
      } else {
        console.error(`Unknown relation action: ${action}`);
        process.exit(1);
      }
      break;
    }
    case "subtask": {
      const id = args[1];
      if (!id) { console.error("Error: task ID is required"); process.exit(1); }
      const action = args[2]?.toLowerCase();
      const task = await readTask(id);
      if (!task.subtasks) task.subtasks = [];

      if (!action || action === "list") {
        if (task.subtasks.length === 0) { console.log(`No subtasks on "${task.title}"`); break; }
        console.log(`Subtasks for "${task.title}":\n`);
        for (let i = 0; i < task.subtasks.length; i++) {
          const s = task.subtasks[i];
          console.log(`  ${i}. [${s.completed ? "x" : " "}] ${s.text}`);
        }
      } else if (action === "add") {
        const text = args.slice(3).join(" ");
        if (!text) { console.error("Error: subtask text is required"); process.exit(1); }
        task.subtasks.push({ text, completed: false });
        await writeTask(task);
        console.log(`Added subtask "${text}" to "${task.title}" (${task.subtasks.length} total)`);
      } else if (action === "toggle") {
        const idx = parseInt(args[3], 10);
        if (isNaN(idx)) { console.error("Error: index is required"); process.exit(1); }
        if (idx < 0 || idx >= task.subtasks.length) {
          console.error(`Error: index ${idx} out of range (0-${task.subtasks.length - 1})`);
          process.exit(1);
        }
        task.subtasks[idx].completed = !task.subtasks[idx].completed;
        const state = task.subtasks[idx].completed ? "completed" : "incomplete";
        await writeTask(task);
        console.log(`Toggled subtask "${task.subtasks[idx].text}" to ${state}`);
      } else if (action === "remove") {
        const idx = parseInt(args[3], 10);
        if (isNaN(idx)) { console.error("Error: index is required"); process.exit(1); }
        if (idx < 0 || idx >= task.subtasks.length) {
          console.error(`Error: index ${idx} out of range (0-${task.subtasks.length - 1})`);
          process.exit(1);
        }
        const removed = task.subtasks.splice(idx, 1)[0];
        await writeTask(task);
        console.log(`Removed subtask "${removed.text}" (${task.subtasks.length} remaining)`);
      } else {
        console.error(`Unknown subtask action: ${action}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(usage());
      process.exit(1);
  }
}

run().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
