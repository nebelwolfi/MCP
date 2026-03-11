import type { Frontmatter, Subtask, Relation } from "./types.js";

export function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
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

export function parseSubtasks(body: string): { subtasks: Subtask[]; description: string } {
  const match = body.match(/## Sub-tasks\r?\n([\s\S]*?)(?=\n## |\n*$)/);
  if (!match) return { subtasks: [], description: body.trim() };

  const subtasks: Subtask[] = [];
  for (const line of match[1].split("\n")) {
    const m = line.match(/^- \[([ xX])\] (.+)$/);
    if (m) subtasks.push({ text: m[2].trim(), completed: m[1] !== " " });
  }

  const description = body.replace(/\n*## Sub-tasks[\s\S]*/, "").trim();
  return { subtasks, description };
}

export function parseRelations(body: string): { relations: Relation[]; body: string } {
  const match = body.match(/\n*## Relations\r?\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!match) return { relations: [], body };

  const relations: Relation[] = [];
  for (const line of match[1].split("\n")) {
    const linkM = line.match(/^- \[([^\]]+)\]\([^)]+\)$/);
    const bracketM = !linkM && line.match(/^- \[([^\]]+)\]$/);
    const text = linkM ? linkM[1].trim() : bracketM ? bracketM[1].trim() : null;
    if (!text) continue;
    const parts = text.split(" ");
    const type = parts.length > 1 ? parts[0] : "";
    const taskId = parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
    relations.push({ type, taskId });
  }

  const cleanBody = body.replace(/\n*## Relations[\s\S]*?(?=\n## |$)/, "").trim();
  return { relations, body: cleanBody };
}

export function serializeBody(description: string, subtasks?: Subtask[], relations?: Relation[]): string {
  let body = description || "";
  if (subtasks && subtasks.length > 0) {
    if (body) body += "\n\n";
    body += "## Sub-tasks\n";
    for (const st of subtasks)
      body += `- [${st.completed ? "x" : " "}] ${st.text}\n`;
  }
  if (relations && relations.length > 0) {
    if (body) body += "\n\n";
    body += "## Relations\n";
    for (const r of relations) {
      const label = r.type ? `${r.type} ${r.taskId}` : r.taskId;
      body += `- [${label}](${r.taskId}.md)\n`;
    }
  }
  return body;
}
