import type { AgColumn } from '../../entities/agColumn';
import type { CellCtrl } from '../cell/cellCtrl';
import { RowCtrl } from '../row/rowCtrl';
export declare class SpannedRowCtrl extends RowCtrl {
    protected getInitialRowClasses(): string[];
    getNewCellCtrl(col: AgColumn<any>): CellCtrl | undefined;
    isCorrectCtrlForSpan(cell: CellCtrl): boolean;
    /**
     * Below overrides are explicitly disabling styling and other unwanted behaviours for spannedRowCtrl
     */
    protected onRowHeightChanged(): void;
    protected refreshFirstAndLastRowStyles(): void;
    protected addHoverFunctionality(): void;
    resetHoveredStatus(): void;
}
