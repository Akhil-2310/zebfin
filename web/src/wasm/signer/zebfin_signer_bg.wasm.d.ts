/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const exportAccount: (a: number, b: number, c: number) => [number, number, number, number];
export const generateSeed: (a: number) => [number, number, number, number];
export const sign: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
export const summarize: (a: number, b: number) => [number, number, number, number];
export const validatePayee: (a: number, b: number) => [number, number];
export const rustsecp256k1_v0_14_context_create: (a: number) => number;
export const rustsecp256k1_v0_14_context_destroy: (a: number) => void;
export const rustsecp256k1_v0_14_default_illegal_callback_fn: (a: number, b: number) => void;
export const rustsecp256k1_v0_14_default_error_callback_fn: (a: number, b: number) => void;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
