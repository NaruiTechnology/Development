import type { BeanCollection } from '../context/context';
import type { Column } from '../interfaces/iColumn';
import type { CellValueResolveFrom } from '../interfaces/iEditService';
import type { IRowNode } from '../interfaces/iRowNode';
export interface GetCellValueParams<TValue = any> {
    /** The row to read from */
    rowNode: IRowNode;
    /** The column to read (field name, `colId`, or `Column` object) */
    colKey: string | Column<TValue>;
    /** If `true`, returns the formatted string (via the column's `valueFormatter`) instead of the raw value. */
    useFormatter?: boolean;
    /**
     * Controls which base value is returned.
     * - `'edit'` (default): Live editor value if the cell is being edited, then any pending batch value, then committed data.
     * - `'batch'`: Pending batch values but excluding live editor typing.
     * - `'data'`: Committed data only, ignoring all edit state.
     */
    from?: CellValueResolveFrom;
    /**
     * If `true`, applies the Show Values As transform (e.g. a percentage of a total) on top of the `from` base.
     * Columns without an active mode return the base value unchanged.
     */
    transformValues?: boolean;
}
export declare function expireValueCache(beans: BeanCollection): void;
export declare function getCellValue<TValue = any>(beans: BeanCollection, params: GetCellValueParams<TValue>): any;
