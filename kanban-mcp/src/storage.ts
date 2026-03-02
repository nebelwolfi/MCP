import { readFile, writeFile, readdir, mkdir, unlink, access, rename, cp, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Task, BoardIndex } from "./types.js";
import { TASKS_DIR, INDEX_FILE, DEFAULT_COLUMNS } from "./constants.js";
import { cwd, kanbanPath, localKanbanPath, now } from "./helpers.js";
import { parseFrontmatter, toMarkdown, parseSubtasks, serializeBody } from "./parsers.js";

export async function boardExists(): Promise<boolean> {
  try { await access(kanbanPath(INDEX_FILE)); return true; } catch { return false; }
}

export async function readIndex(): Promise<BoardIndex> {
  const content = await readFile(kanbanPath(INDEX_FILE), "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  const nameMatch = body.match(/^# (.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : basename(cwd());

  const columns: string[] = [];
  const tasksByColumn: Record<string, string[]> = {};
  const h2Regex = /^## (.+)$/gm;
  const h2Positions: { name: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;

  while ((m = h2Regex.exec(body)) !== null) {
    h2Positions.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < h2Positions.length; i++) {
    const col = h2Positions[i].name;
    columns.push(col);
    tasksByColumn[col] = [];

    const sectionText = body.slice(
      h2Positions[i].end,
      i + 1 < h2Positions.length ? h2Positions[i + 1].start : body.length
    );

    const linkRegex = /^- \[([^\]]+)\]\(tasks\/[^)]+\.md\)/gm;
    let lm: RegExpExecArray | null;
    while ((lm = linkRegex.exec(sectionText)) !== null) {
      tasksByColumn[col].push(lm[1]);
    }
  }

  return {
    name,
    columns,
    tasksByColumn,
    startedColumns: Array.isArray(frontmatter.startedColumns) ? frontmatter.startedColumns as string[] : [],
    completedColumns: Array.isArray(frontmatter.completedColumns) ? frontmatter.completedColumns as string[] : [],
  };
}

export async function writeIndex(index: BoardIndex): Promise<void> {
  await mkdir(kanbanPath(), { recursive: true });

  const fm: Record<string, string[]> = {};
  if (index.startedColumns?.length) fm.startedColumns = index.startedColumns;
  if (index.completedColumns?.length) fm.completedColumns = index.completedColumns;

  let body = `# ${index.name}\n`;
  for (const col of index.columns) {
    const tasks = index.tasksByColumn[col] ?? [];
    body += `\n## ${col}\n`;
    if (tasks.length > 0) {
      body += "\n";
      for (const id of tasks) body += `- [${id}](tasks/${id}.md)\n`;
    }
  }

  await writeFile(kanbanPath(INDEX_FILE), toMarkdown(fm, body));
}

export async function ensureBoard(): Promise<void> {
  if (await boardExists()) return;
  try {
    await access(localKanbanPath(INDEX_FILE));
    await mkdir(dirname(kanbanPath()), { recursive: true });
    await cp(localKanbanPath(), kanbanPath(), { recursive: true });
    await rm(localKanbanPath(), { recursive: true, force: true });
    return;
  } catch { /* no local board to migrate */ }
  await mkdir(kanbanPath(TASKS_DIR), { recursive: true });
  await writeIndex({
    name: basename(cwd()),
    columns: [...DEFAULT_COLUMNS],
    tasksByColumn: Object.fromEntries(DEFAULT_COLUMNS.map((c) => [c, []])),
    startedColumns: ["In Progress"],
    completedColumns: ["Done"],
  });
}

export async function readTask(id: string): Promise<Task> {
  const content = await readFile(kanbanPath(TASKS_DIR, `${id}.md`), "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  const titleMatch = body.match(/^# (.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : id;

  const bodyWithoutTitle = body.replace(/^# .+\n+/, "");
  const { subtasks, description } = parseSubtasks(bodyWithoutTitle);

  return {
    id,
    title,
    description: description.replace(/\n*## Relations[\s\S]*$/, "").trim(),
    subtasks,
    created: (frontmatter.created as string) ?? now(),
    updated: (frontmatter.updated as string) ?? now(),
    started: frontmatter.started as string | undefined,
    completed: frontmatter.completed as string | undefined,
    priority: (frontmatter.priority as Task["priority"]) ?? "medium",
    assignee: (frontmatter.assignee as string) ?? "",
    tags: Array.isArray(frontmatter.tags)
      ? frontmatter.tags as string[]
      : frontmatter.tags ? [frontmatter.tags as string] : [],
  };
}

export async function writeTask(task: Task): Promise<void> {
  const fm: Record<string, string | string[]> = {
    created: task.created ?? now(),
    updated: now(),
  };
  if (task.started)   fm.started   = task.started;
  if (task.completed) fm.completed = task.completed;
  if (task.priority && task.priority !== "medium") fm.priority = task.priority;
  if (task.assignee)  fm.assignee  = task.assignee;
  if (task.tags?.length) fm.tags   = task.tags;

  const content = serializeBody(task.description, task.subtasks);
  const body = `# ${task.title}` + (content ? `\n\n${content}` : "");

  await writeFile(kanbanPath(TASKS_DIR, `${task.id}.md`), toMarkdown(fm, body));
}

export async function deleteTaskFile(id: string): Promise<void> {
  await unlink(kanbanPath(TASKS_DIR, `${id}.md`));
}

export async function listTaskIds(): Promise<string[]> {
  try {
    const index = await readIndex();
    return index.columns.flatMap((c) => index.tasksByColumn[c] ?? []);
  } catch { return []; }
}

export async function getAllTasksWithColumns(): Promise<{ tasks: (Task & { column: string })[]; index: BoardIndex }> {
  const index = await readIndex();
  const tasks: (Task & { column: string })[] = [];
  for (const col of index.columns) {
    for (const id of (index.tasksByColumn[col] ?? [])) {
      try {
        tasks.push({ ...(await readTask(id)), column: col });
      } catch { /* skip missing files */ }
    }
  }
  return { tasks, index };
}

export async function listOrphanedFiles(): Promise<string[]> {
  try {
    const files = await readdir(kanbanPath(TASKS_DIR));
    const index = await readIndex();
    const indexed = new Set(index.columns.flatMap((c) => index.tasksByColumn[c] ?? []));
    return files
      .filter((f) => f.endsWith(".md"))
      .filter((f) => !indexed.has(f.replace(".md", "")));
  } catch { return []; }
}
