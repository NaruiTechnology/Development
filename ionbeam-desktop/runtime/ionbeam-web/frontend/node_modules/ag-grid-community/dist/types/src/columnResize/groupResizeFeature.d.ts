import { BeanStub } from '../context/beanStub';
import type { AgColumn } from '../entities/agColumn';
import type { AgColumnGroup } from '../entities/agColumnGroup';
import type { ColumnEventType } from '../events';
import type { IHeaderResizeFeature } from '../headerRendering/cells/abstractCell/abstractHeaderCellCtrl';
import type { IHeaderGroupCellComp } from '../headerRendering/cells/columnGroup/headerGroupCellCtrl';
interface ColumnSizeAndRatios {
    columnsToResize: AgColumn[];
    resizeStartWidth: number;
    resizeRatios: number[];
    groupAfterColumns?: AgColumn[];
    groupAfterStartWidth?: number;
    groupAfterRatios?: number[];
}
export declare class GroupResizeFeature extends BeanStub implements IHeaderResizeFeature {
    private readonly comp;
    private readonly eResize;
    private readonly columnGroup;
    private resizeCols?;
    private resizeStartWidth;
    private resizeRatios?;
    private resizeTakeFromCols?;
    private resizeTakeFromStartWidth?;
    private resizeTakeFromRatios?;
    constructor(comp: IHeaderGroupCellComp, eResize: HTMLElement, columnGroup: AgColumnGroup);
    postConstruct(): void;
    private onResizeStart;
    onResizing(finished: boolean, resizeAmount: any, source?: ColumnEventType): void;
    getInitialValues(shiftKey?: boolean): ColumnSizeAndRatios;
    resizeLeafColumnsToFit(source: ColumnEventType): void;
    private resizeColumnsFromLocalValues;
    resizeColumns(initialValues: ColumnSizeAndRatios, totalWidth: number, source: ColumnEventType, finished?: boolean): void;
    toggleColumnResizing(resizing: boolean): void;
    private getColumnsToResize;
    private normaliseDragChange;
    destroy(): void;
}
export {};
