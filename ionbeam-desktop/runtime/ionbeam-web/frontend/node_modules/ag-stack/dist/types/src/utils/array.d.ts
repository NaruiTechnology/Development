/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _last<T>(arr: readonly T[]): T;
export declare function _last<T extends Node>(arr: NodeListOf<T>): T;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _areEqual<T>(a: readonly T[] | null | undefined, b: readonly T[] | null | undefined, comparator?: (a: T, b: T) => boolean): boolean;
/**
 * Returns `prev` when its contents equal `current`; otherwise `current.slice()` (or `[]` if nullish).
 * `prev === current` returns a fresh slice so callers never get the readonly `current` aliased back.
 *
 * @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time.
 */
export declare function _reuseArrayIfEqual<T>(prev: T[] | null | undefined, current: readonly T[] | null | undefined): T[];
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _removeFromArray<T>(array: T[], object: T): void;
/**
 * O(N+M) way to remove M elements from an array of size N. Better than calling _removeFromArray in a loop
 *
 * Note: this implementation removes _any_ instances of the `elementsToRemove`
 * @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time.
 */
export declare function _removeAllFromArray<T>(array: T[], elementsToRemove: readonly T[]): void;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _moveInArray<T>(array: T[], objectsToMove: T[], toIndex: number): void;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _flatten<T>(arrays: Array<T[]>): T[];
/** Elements present in exactly one of the two arrays (added or removed); nullish/empty counts as
 *  none. Fast paths: equal refs → empty; one side empty → copy of the other (no Set built).
 *  @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _symmetricDiff<T>(a: readonly T[] | null | undefined, b: readonly T[] | null | undefined): T[];
/** Push `value` onto the array bucket at `key` in a `Map<K, V[]>`, creating the bucket on first use.
 *  @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _pushToMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void;
/** Build a `Map<item, index>` for O(1) position lookups, beating repeated `indexOf` (O(N²) over a sort/loop).
 *  @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _indexMap<K>(arr: readonly K[] | null | undefined): Map<K, number>;
