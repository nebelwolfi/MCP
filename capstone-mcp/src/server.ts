import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Capstone, Const, loadCapstone } from "capstone-wasm";
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

export const server = new McpServer({ name: "capstone-mcp", version: "1.0.0" });

const ARCHS: Record<string, { value: number; modes: Record<string, number> }> = {
  x86: {
    value: Const.CS_ARCH_X86,
    modes: { "16": Const.CS_MODE_16, "32": Const.CS_MODE_32, "64": Const.CS_MODE_64 },
  },
  arm: {
    value: Const.CS_ARCH_ARM,
    modes: { arm: Const.CS_MODE_ARM, thumb: Const.CS_MODE_THUMB },
  },
  arm64: {
    value: Const.CS_ARCH_ARM64,
    modes: { default: Const.CS_MODE_ARM },
  },
  mips: {
    value: Const.CS_ARCH_MIPS,
    modes: {
      "32": Const.CS_MODE_MIPS32, "64": Const.CS_MODE_MIPS64,
      micro: Const.CS_MODE_MICRO, "32r6": Const.CS_MODE_MIPS32R6,
    },
  },
  ppc: {
    value: Const.CS_ARCH_PPC,
    modes: { "32": Const.CS_MODE_32, "64": Const.CS_MODE_64 },
  },
  sparc: {
    value: Const.CS_ARCH_SPARC,
    modes: { default: Const.CS_MODE_BIG_ENDIAN, v9: Const.CS_MODE_V9 },
  },
  sysz: {
    value: Const.CS_ARCH_SYSZ,
    modes: { default: Const.CS_MODE_BIG_ENDIAN },
  },
  xcore: {
    value: Const.CS_ARCH_XCORE,
    modes: { default: Const.CS_MODE_BIG_ENDIAN },
  },
  m68k: {
    value: Const.CS_ARCH_M68K,
    modes: { default: Const.CS_MODE_BIG_ENDIAN },
  },
};

let initialized = false;
async function ensureInit() {
  if (!initialized) {
    await loadCapstone();
    initialized = true;
  }
}

function parseHex(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "").replace(/[\s,]/g, "");
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2 !== 0) {
    throw new Error("Invalid hex string — expected pairs of hex digits (e.g. '4889e5' or '48 89 e5')");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

function resolveArch(arch: string, mode: string): { archVal: number; modeVal: number } {
  const a = ARCHS[arch.toLowerCase()];
  if (!a) throw new Error(`Unknown architecture: ${arch}. Use list_architectures to see valid options.`);
  const m = a.modes[mode.toLowerCase()];
  if (m === undefined) throw new Error(`Unknown mode '${mode}' for ${arch}. Valid modes: ${Object.keys(a.modes).join(", ")}`);
  return { archVal: a.value, modeVal: m };
}

function formatInsns(insns: { address: number | bigint; mnemonic: string; opStr: string; bytes: Uint8Array }[]): string {
  if (insns.length === 0) return "(no instructions decoded)";
  return insns.map((i) => {
    const addr = typeof i.address === "bigint" ? "0x" + i.address.toString(16) : "0x" + i.address.toString(16);
    const hex = Array.from(i.bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    return `${addr.padEnd(18)} ${hex.padEnd(24)} ${i.mnemonic} ${i.opStr}`.trimEnd();
  }).join("\n");
}

const wrap = (fn: (params: Record<string, unknown>) => Promise<string>) =>
  async (params: Record<string, unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: await fn(params) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : e}` }], isError: true };
    }
  };

server.tool(
  "disassemble",
  "Disassemble a hex string of machine code bytes",
  {
    hex: z.string().describe("Hex-encoded bytes (e.g. '4889e5' or '48 89 e5')"),
    arch: z.string().describe("Architecture (x86, arm, arm64, mips, ppc, sparc, sysz, xcore, m68k)"),
    mode: z.string().describe("Mode (arch-dependent, e.g. '32', '64', 'thumb'). Use list_architectures to see options."),
    base_address: z.string().optional().describe("Base address for disassembly (hex, e.g. '0x401000'). Defaults to 0x0."),
  },
  wrap(async (p) => {
    await ensureInit();
    const { archVal, modeVal } = resolveArch(p.arch as string, p.mode as string);
    const data = parseHex(p.hex as string);
    const base = p.base_address ? parseInt(p.base_address as string, 16) : 0;
    const cs = new Capstone(archVal, modeVal);
    try {
      const insns = cs.disasm(data, { address: base });
      return formatInsns(insns);
    } finally {
      cs.close();
    }
  }),
);

server.tool(
  "disassemble_file",
  "Read bytes from a file at a given offset and disassemble them",
  {
    path: z.string().describe("File path (absolute, or relative to cwd)"),
    offset: z.number().int().min(0).describe("Byte offset to start reading from"),
    count: z.number().int().min(1).max(1000).describe("Number of instructions to disassemble"),
    arch: z.string().describe("Architecture (x86, arm, arm64, mips, ppc, sparc, sysz, xcore, m68k)"),
    mode: z.string().describe("Mode (arch-dependent, e.g. '32', '64', 'thumb')"),
    base_address: z.string().optional().describe("Base address (hex). Defaults to the offset value."),
  },
  wrap(async (p) => {
    await ensureInit();
    const { archVal, modeVal } = resolveArch(p.arch as string, p.mode as string);
    const filePath = isAbsolute(p.path as string) ? (p.path as string) : resolve(process.cwd(), p.path as string);
    const offset = p.offset as number;
    const count = p.count as number;
    const maxRead = count * 15;
    const buf = await readFile(filePath);
    if (offset >= buf.length) throw new Error(`Offset ${offset} (0x${offset.toString(16)}) is past end of file (${buf.length} bytes)`);
    const slice = buf.subarray(offset, Math.min(offset + maxRead, buf.length));
    const base = p.base_address ? parseInt(p.base_address as string, 16) : offset;
    const cs = new Capstone(archVal, modeVal);
    try {
      const insns = cs.disasm(slice, { address: base, count });
      return formatInsns(insns);
    } finally {
      cs.close();
    }
  }),
);

server.tool(
  "list_architectures",
  "List all supported architecture and mode combinations",
  {},
  wrap(async () => {
    const lines: string[] = [];
    for (const [name, info] of Object.entries(ARCHS)) {
      lines.push(`${name}: ${Object.keys(info.modes).join(", ")}`);
    }
    return lines.join("\n");
  }),
);
