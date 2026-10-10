/* tslint:disable */
/* eslint-disable */

export class CoreDocument {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    canRedo(): boolean;
    canUndo(): boolean;
    /**
     * One user action: `ops` is a JSON array of edit ops; returns the change-set JSON.
     */
    edit(label: string, ops: string): string;
    /**
     * Loads the app's alphaTab JSON (a string).
     */
    static fromJson(json: string): CoreDocument;
    /**
     * A track ({track}) or staff ({track, staff}) without its children.
     */
    headerJson(at: string): string;
    /**
     * JSON of the node at a position (JSON {track, staff, bar} ...; {} = the whole score).
     */
    nodeJson(at: string): string;
    redo(): string | undefined;
    toJson(): string;
    /**
     * Undo; returns the change-set JSON, or undefined when there is nothing to undo.
     */
    undo(): string | undefined;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_coredocument_free: (a: number, b: number) => void;
    readonly coredocument_canRedo: (a: number) => number;
    readonly coredocument_canUndo: (a: number) => number;
    readonly coredocument_edit: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly coredocument_fromJson: (a: number, b: number) => [number, number, number];
    readonly coredocument_headerJson: (a: number, b: number, c: number) => [number, number, number, number];
    readonly coredocument_nodeJson: (a: number, b: number, c: number) => [number, number, number, number];
    readonly coredocument_redo: (a: number) => [number, number, number, number];
    readonly coredocument_toJson: (a: number) => [number, number];
    readonly coredocument_undo: (a: number) => [number, number, number, number];
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
