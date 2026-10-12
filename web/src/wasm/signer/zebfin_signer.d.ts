/* tslint:disable */
/* eslint-disable */

/**
 * The view-only export for an existing seed. JSON `{ ufvk, seed_fingerprint, account_index }`.
 */
export function exportAccount(mnemonic: string, account_index: number): string;

/**
 * Generates a new 24-word seed. Returns JSON `{ mnemonic, ufvk, seed_fingerprint, account_index }`.
 */
export function generateSeed(account_index: number): string;

/**
 * Signs every Orchard/Ironwood spend in `pczt` that belongs to this seed.
 */
export function sign(mnemonic: string, account_index: number, pczt: Uint8Array): Uint8Array;

/**
 * Decodes what a PCZT pays, computed locally from the PCZT bytes (never
 * trusting a server-provided summary). JSON `PcztSummary`.
 */
export function summarize(pczt: Uint8Array): string;

/**
 * Validates a payee address (Orchard receiver, testnet).
 */
export function validatePayee(address: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly exportAccount: (a: number, b: number, c: number) => [number, number, number, number];
    readonly generateSeed: (a: number) => [number, number, number, number];
    readonly sign: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly summarize: (a: number, b: number) => [number, number, number, number];
    readonly validatePayee: (a: number, b: number) => [number, number];
    readonly rustsecp256k1_v0_14_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_14_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_14_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_14_default_error_callback_fn: (a: number, b: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
