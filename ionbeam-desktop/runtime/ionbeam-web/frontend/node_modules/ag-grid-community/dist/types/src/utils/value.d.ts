/**
 * Reads a deep property from `data` following a pre-split dotted path. Hot-path variant of
 * `_getValueUsingDotField` (ag-stack): callers reading the same field per cell cache `field.split('.')` once
 * (on colDef update) and use this, avoiding a split + array allocation per read.
 * @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time.
 */
export declare function _getValueUsingDotPath(data: any, fields: string[]): any;
