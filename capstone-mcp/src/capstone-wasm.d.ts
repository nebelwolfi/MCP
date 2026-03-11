declare module "capstone-wasm" {
  interface Insn {
    id: number;
    address: number | bigint;
    size: number;
    bytes: Uint8Array;
    mnemonic: string;
    opStr: string;
  }

  class Capstone {
    arch: number;
    mode: number;
    constructor(arch: number, mode: number);
    disasm(data: number[] | Uint8Array, options?: { address?: number | bigint; count?: number }): Insn[];
    setOption(opt: number, value: number): number;
    close(): void;
    getRegName(id: number): string;
    getInsnName(id: number): string;
    getGroupName(id: number): string;
    errNo(): number;
    static version(): { major: number; minor: number };
    static support(query: number): boolean;
    static strError(errNo: number): string;
  }

  function loadCapstone(args?: Record<string, unknown>): Promise<void>;

  namespace Const {
    const CS_ARCH_ARM: number;
    const CS_ARCH_ARM64: number;
    const CS_ARCH_MIPS: number;
    const CS_ARCH_X86: number;
    const CS_ARCH_PPC: number;
    const CS_ARCH_SPARC: number;
    const CS_ARCH_SYSZ: number;
    const CS_ARCH_XCORE: number;
    const CS_ARCH_M68K: number;
    const CS_ARCH_TMS320C64X: number;
    const CS_ARCH_M680X: number;
    const CS_MODE_LITTLE_ENDIAN: number;
    const CS_MODE_ARM: number;
    const CS_MODE_16: number;
    const CS_MODE_32: number;
    const CS_MODE_64: number;
    const CS_MODE_THUMB: number;
    const CS_MODE_MCLASS: number;
    const CS_MODE_V8: number;
    const CS_MODE_MICRO: number;
    const CS_MODE_MIPS3: number;
    const CS_MODE_MIPS32R6: number;
    const CS_MODE_MIPS2: number;
    const CS_MODE_BIG_ENDIAN: number;
    const CS_MODE_V9: number;
    const CS_MODE_MIPS32: number;
    const CS_MODE_MIPS64: number;
    const CS_MODE_QPX: number;
    const CS_OPT_SYNTAX: number;
    const CS_OPT_DETAIL: number;
    const CS_OPT_SYNTAX_INTEL: number;
    const CS_OPT_SYNTAX_ATT: number;
  }
}
