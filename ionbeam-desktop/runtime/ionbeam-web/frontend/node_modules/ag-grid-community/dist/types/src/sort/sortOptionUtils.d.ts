import type { ColumnModel } from '../columns/columnModel';
import type { SortOption } from '../interfaces/iSortOption';
/**
 * Resolves each option's comparators in place so the sorter reads them directly per comparison: a comparator on
 * the col applies to every row; a row-group display col otherwise falls back to its primary column's comparator
 * (the sorter applies that fallback to leaf rows only). Call once after building an option array, before sorting.
 * @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time.
 */
export declare const _resolveSortOptions: (options: SortOption[], colModel: ColumnModel) => void;
