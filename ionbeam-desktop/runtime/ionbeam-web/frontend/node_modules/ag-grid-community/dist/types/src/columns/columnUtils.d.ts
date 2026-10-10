import type { AgPropertyChangedSource } from 'ag-stack';
import type { BeanCollection } from '../context/context';
import type { AgColumn } from '../entities/agColumn';
import type { AgProvidedColumnGroup } from '../entities/agProvidedColumnGroup';
import type { ColDef, ColGroupDef } from '../entities/colDef';
import type { ColumnEventType } from '../events';
import type { Column } from '../interfaces/iColumn';
import type { ColumnState } from './columnStateUtils';
export declare const GROUP_AUTO_COLUMN_ID = "ag-Grid-AutoColumn";
export declare const SELECTION_COLUMN_ID = "ag-Grid-SelectionColumn";
export declare const ROW_NUMBERS_COLUMN_ID = "ag-Grid-RowNumbersColumn";
export declare const GROUP_HIERARCHY_COLUMN_ID_PREFIX = "ag-Grid-HierarchyColumn";
export declare function getWidthOfColsInList(columnList: AgColumn[]): number;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function isColumnGroupAutoCol(col: Column): boolean;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function isColumnSelectionCol(col: Column): boolean;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function isRowNumberCol(col: Column): boolean;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function isSpecialCol(col: Column): boolean;
export declare function convertColumnTypes(type: string | string[]): string[];
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _convertColumnEventSourceType(source: AgPropertyChangedSource): ColumnEventType;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _getColumnStateFromColDef(beans: BeanCollection, colDef: ColDef, colId: string): ColumnState;
export declare function getSortDefFromColDef(colDef: ColDef): import("../main-umd-noStyles").SortDef | null;
/** Destroys every still-alive node via flat lists (not `.children`, which a reused group may have replaced);
 *  the `isAlive()` guard de-dups nodes reachable via multiple paths (hierarchy cols sit in colDefList + wrappers).
 *  @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const _destroyColumnTreeAll: (cols: readonly AgColumn[] | null, allGroups: readonly AgProvidedColumnGroup[] | null) => void;
/** Destroys prev-build nodes absent from the new build. Walks flat prev lists, not `.children`:
 *  orphans whose parent's array was replaced are otherwise unreachable.
 *  @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const _destroyColumnTreeUnused: (prevCols: readonly AgColumn[], prevAllGroups: readonly AgProvidedColumnGroup[], buildToken: number) => void;
/** Calls `callback` for each leaf `ColDef`, recursing into `ColGroupDef` children; not called on groups. */
export declare function forEachColDef(columnDefs: (ColDef | ColGroupDef)[], callback: (colDef: ColDef) => void): void;
