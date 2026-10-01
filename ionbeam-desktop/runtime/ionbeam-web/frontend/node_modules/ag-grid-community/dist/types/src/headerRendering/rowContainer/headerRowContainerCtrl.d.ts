import { BeanStub } from '../../context/beanStub';
import type { AgColumn } from '../../entities/agColumn';
import type { AgColumnGroup } from '../../entities/agColumnGroup';
import type { ScrollPartner } from '../../gridBodyComp/gridBodyScrollFeature';
import type { AbstractHeaderCellCtrl } from '../cells/abstractCell/abstractHeaderCellCtrl';
import type { HeaderRowType } from '../row/headerRowComp';
import { HeaderRowCtrl } from '../row/headerRowCtrl';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export interface IHeaderRowsComp {
    setViewportScrollLeft(left: number): void;
    setCtrls(ctrls: HeaderRowCtrl[]): void;
}
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class HeaderRowContainerCtrl extends BeanStub implements ScrollPartner {
    comp: IHeaderRowsComp;
    private includeFloatingFilter;
    private filtersRowCtrl;
    private columnsRowCtrl;
    private groupsRowCtrls;
    eViewport: HTMLElement;
    setComp(comp: IHeaderRowsComp, eGui: HTMLElement, eScrollViewport?: HTMLElement): void;
    getAllCtrls(): HeaderRowCtrl[];
    refresh(keepColumns?: boolean): void;
    getHeaderCtrlForColumn(column: AgColumn | AgColumnGroup): AbstractHeaderCellCtrl | undefined;
    getHtmlElementForColumnHeader(column: AgColumn | AgColumnGroup): HTMLElement | null;
    getRowType(rowIndex: number): HeaderRowType | undefined;
    focusHeader(rowIndex: number, column: AgColumn | AgColumnGroup, event?: KeyboardEvent): boolean;
    getGroupRowCount(): number;
    getGroupRowCtrlAtIndex(index: number): HeaderRowCtrl;
    getRowCount(): number;
    setHorizontalScroll(offset: number): void;
    onScrollCallback(fn: () => void): void;
    destroy(): void;
    private setupDragAndDrop;
    private restoreFocusOnHeader;
}
