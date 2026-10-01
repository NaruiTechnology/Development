import type { NamedBean } from '../../context/bean';
import { BeanStub } from '../../context/beanStub';
import type { AgColumn } from '../../entities/agColumn';
import type { RowNode } from '../../entities/rowNode';
import type { CellPosition } from '../../interfaces/iCellPosition';
import type { CellSpan } from './rowSpanCache';
export declare class RowSpanService extends BeanStub<'spannedCellsUpdated'> implements NamedBean {
    beanName: "rowSpanSvc";
    /** Active only if `enableCellSpan=true` */
    active: boolean;
    private spanningColumns;
    postConstruct(): void;
    /** Create and build a span cache for `column`. Idempotent. */
    private register;
    /** `spanRows` config changed: start spanning, stop spanning, or rebuild if it still spans. */
    columnRowSpanChanged(column: AgColumn): void;
    /** Register newly-added spanning columns. Called post-commit, when values (e.g. calc cols) resolve. */
    refreshCols(): void;
    /** Rebuild all regions for one column's cache and signal consumers to re-render. */
    private buildCache;
    private readonly debouncePinnedEvent;
    private readonly debounceModelEvent;
    private dispatchCellsUpdatedEvent;
    /** Drop `column`'s span cache (column destroyed or no longer spanning). */
    deregister(column: AgColumn): void;
    private pinnedTimeout;
    private modelTimeout;
    private onRowDataUpdated;
    private buildModelCaches;
    private buildPinnedCaches;
    isCellSpanning(col: AgColumn, rowNode: RowNode): boolean;
    getCellSpanByPosition(position: CellPosition): CellSpan | undefined;
    getCellStart(position: CellPosition): CellPosition | undefined;
    getCellEnd(position: CellPosition): CellPosition | undefined;
    /** Look up the spanned cell at `column`/`rowNode`, if any. */
    getCellSpan(column: AgColumn, rowNode: RowNode): CellSpan | undefined;
    forEachSpannedColumn(rowNode: RowNode, callback: (column: AgColumn, span: CellSpan) => void): void;
    private clearModelTimeout;
    private clearPinnedTimeout;
    destroy(): void;
}
