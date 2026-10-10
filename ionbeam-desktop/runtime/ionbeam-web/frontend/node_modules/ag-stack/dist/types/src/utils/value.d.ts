/**
 * Reads a deep property from `data` using a dotted path. Callers must have already verified
 * that the field contains dots — for plain field names use `data[field]` directly.
 * @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time.
 */
export declare function _getValueUsingDotField(data: any, field: string): any;
