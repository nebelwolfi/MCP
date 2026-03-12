import type { ChildProcess } from "node:child_process";

export interface Config {
  workers: number;
  iterationsPerWorker: number;
  skipBuild: boolean;
  cleanup: boolean;
  mergeOnly: boolean;
  baseBranch: string;
  projectDir: string;
}

export type LogLevel = "INFO" | "ERROR" | "WARN" | "OK";

export interface Frontmatter {
  [key: string]: string | number | string[] | undefined;
}

export interface Subtask {
  text: string;
  completed: boolean;
}

export interface Relation {
  type: string;
  taskId: string;
}

export interface TaskInfo {
  id: string;
  title: string;
  subTasks: Subtask[];
  relations: Relation[];
  column: string;
  tags: string[];
  priority: string;
}

export interface BoardIndex {
  name: string;
  columns: string[];
  tasksByColumn: Record<string, string[]>;
  startedColumns: string[];
  completedColumns: string[];
}

export interface BoardJson {
  headings: { name: string }[];
  lanes: { columns: TaskInfo[][] }[];
  startedColumns: string[];
  completedColumns: string[];
}

export interface ClaimResult {
  taskId: string;
  claimedSubTask: string | null;
}

export type WorkerStatus = "TASK_COMPLETE" | "NO_COMMITS" | "ERROR" | "MERGE_REVIEW_DONE" | "MERGE_REVIEW_ERROR" | "UNKNOWN";

export interface WorkerResult {
  status: WorkerStatus;
  workerId: number;
  taskId: string;
  error?: string;
}

export interface ActiveJob {
  promise: Promise<WorkerResult>;
  process: ChildProcess;
  taskId: string;
  claimedSubTask: string | null;
}

export interface PullRequest {
  number: number;
  headRefName: string;
  mergeable: string;
  mergeStateStatus: string;
}

export interface OrchestratorState {
  mainRepo: string;
  baseBranch: string;
  worktreeRoot: string;
  logDir: string;
  submodules: string[];
  claimedTasks: Map<string, number>;
  claimedSubTasks: Map<string, string>;
  completedTasks: Set<string>;
}
