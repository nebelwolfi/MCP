import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const server = new McpServer({ name: "converter", version: "1.0.0" });

const wrap = (fn: (params: Record<string, unknown>) => string) =>
  async (params: Record<string, unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: fn(params) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  };

server.tool(
  "dec_to_hex",
  "Convert a decimal number (or comma-separated list) to hexadecimal",
  { value: z.string().describe("Decimal number(s), comma-separated for batch") },
  wrap((p) => {
    const results = (p.value as string).split(",").map((v) => {
      const trimmed = v.trim();
      const n = BigInt(trimmed);
      const hex = n < 0n ? "-0x" + (-n).toString(16).toUpperCase() : "0x" + n.toString(16).toUpperCase();
      return `${trimmed} => ${hex}`;
    });
    return results.join("\n");
  })
);

server.tool(
  "hex_to_dec",
  "Convert a hexadecimal number (or comma-separated list) to decimal",
  { value: z.string().describe("Hex number(s), comma-separated for batch (0x prefix optional)") },
  wrap((p) => {
    const results = (p.value as string).split(",").map((v) => {
      const trimmed = v.trim();
      const normalized = trimmed.startsWith("-")
        ? "-" + trimmed.slice(1).replace(/^0[xX]/, "")
        : trimmed.replace(/^0[xX]/, "");
      const n = BigInt("0x" + normalized.replace(/^-/, ""));
      const dec = normalized.startsWith("-") ? (-n).toString() : n.toString();
      return `${trimmed} => ${dec}`;
    });
    return results.join("\n");
  })
);
