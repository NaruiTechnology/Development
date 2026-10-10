import { BeanStub } from '../context/beanStub';
import { AgColumn } from '../entities/agColumn';
import type { ColKind } from '../entities/agColumn';
import type { ColDef } from '../entities/colDef';
import type { ColumnEventType } from '../events';
/** Base for services owning a single optional generated column (selection, row-numbers); shared create/refresh/teardown.
 *  @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare abstract class BaseSingleColService extends BeanStub {
    /** The owned column, or null when disabled. Only ever 0 or 1 column — singular by design, no array allocation. */
    column: AgColumn | null;
    /** The `AgColumn` kind discriminator for the generated column. */
    protected abstract readonly colKind: ColKind;
    /** Whether the column should currently exist, from grid options. */
    abstract isEnabled(): boolean;
    /** Build the colDef for the column from current grid options. */
    protected abstract createColDef(): ColDef;
    destroy(): void;
    /** Generate or destroy the column based on current options. */
    refreshCols(): AgColumn | null;
    /** Rebuild the colDef on the existing column and re-apply its state. No-op when the column doesn't exist. */
    protected refreshColDef(source: ColumnEventType): void;
    protected destroyColumn(): void;
}
