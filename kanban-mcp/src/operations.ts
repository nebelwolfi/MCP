import type { Task, CreateTaskParams, FindTasksParams } from "./types.js";
import { now, generateTaskId } from "./helpers.js";
import {
  ensureBoard, readIndex, writeIndex,
  readTask, writeTask, deleteTaskFile,
  listTaskIds, getAllTasksWithColumns, withLock,
} from "./storage.js";

export async function createTask(params: CreateTaskParams): Promise<Task & { column: string }> {
  return withLock(async () => {
    await ensureBoard();
    const index = await readIndex();
    const column = params.column ?? index.columns[0] ?? "Backlog";
    if (!index.columns.includes(column))
      throw new Error(`Column "${column}" does not exist. Available: ${index.columns.join(", ")}`);

    const id = generateTaskId();

    const task: Task = {
      id,
      title: params.title,
      description: params.description ?? "",
      subtasks: (params.subtasks ?? []).map((text) => ({ text, completed: false })),
      relations: [],
      created: now(),
      updated: now(),
      priority: params.priority ?? "medium",
      assignee: params.assignee ?? "",
      tags: params.tags ?? [],
    };

    await writeTask(task);

    if (!index.tasksByColumn[column]) index.tasksByColumn[column] = [];
    const pos = params.position ?? index.tasksByColumn[column].length;
    index.tasksByColumn[column].splice(pos, 0, id);
    await writeIndex(index);

    return { ...task, column };
  });
}

export async function editTask(id: string, updates: Partial<Pick<Task, "title" | "description" | "priority" | "assignee" | "tags">>): Promise<Task> {
  return withLock(async () => {
    const task = await readTask(id);
    const titleChanged = updates.title !== undefined && updates.title !== task.title;
    for (const key of ["title", "description", "priority", "assignee", "tags"] as const) {
      if (updates[key] !== undefined) (task as unknown as Record<string, unknown>)[key] = updates[key];
    }
    await writeTask(task);

    // If title changed, update the tasks index so it shows the new title
    if (titleChanged) {
      const index = await readIndex();
      await writeIndex(index);
    }

    return task;
  });
}

export async function moveTask(id: string, column: string, position?: number): Promise<Task & { column: string }> {
  return withLock(async () => {
    const index = await readIndex();
    if (!index.columns.includes(column))
      throw new Error(`Column "${column}" does not exist. Available: ${index.columns.join(", ")}`);

    for (const col of index.columns) {
      const arr = index.tasksByColumn[col] ?? [];
      const idx = arr.indexOf(id);
      if (idx !== -1) { arr.splice(idx, 1); break; }
    }

    if (!index.tasksByColumn[column]) index.tasksByColumn[column] = [];
    const pos = position ?? index.tasksByColumn[column].length;
    index.tasksByColumn[column].splice(pos, 0, id);
    await writeIndex(index);

    const task = await readTask(id);
    if (index.startedColumns.includes(column) && !task.started) task.started = now();
    if (index.completedColumns.includes(column) && !task.completed) task.completed = now();
    await writeTask(task);

    return { ...task, column };
  });
}

export async function deleteTask(id: string): Promise<void> {
  return withLock(async () => {
    const index = await readIndex();
    for (const col of index.columns) {
      const arr = index.tasksByColumn[col] ?? [];
      const idx = arr.indexOf(id);
      if (idx !== -1) { arr.splice(idx, 1); break; }
    }
    await writeIndex(index);
    await deleteTaskFile(id);
  });
}

export async function findTasks(params: FindTasksParams): Promise<(Task & { column: string })[]> {
  const { tasks } = await getAllTasksWithColumns();
  return tasks.filter((task) => {
    if (params.column   && task.column   !== params.column)   return false;
    if (params.assignee && task.assignee !== params.assignee) return false;
    if (params.tag      && !task.tags.includes(params.tag))   return false;
    if (params.priority && task.priority !== params.priority) return false;
    if (params.query) {
      const q = params.query.toLowerCase();
      if (!task.title.toLowerCase().includes(q) &&
          !(task.description ?? "").toLowerCase().includes(q) &&
          !task.tags.some((t) => t.toLowerCase().includes(q))) return false;
    }
    return true;
  });
}
