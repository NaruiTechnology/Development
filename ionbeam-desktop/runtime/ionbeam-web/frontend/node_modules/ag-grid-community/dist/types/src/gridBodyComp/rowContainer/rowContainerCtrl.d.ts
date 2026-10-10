import { BeanStub } from '../../context/beanStub';
import type { RowCtrl } from '../../rendering/row/rowCtrl';
import type { RowRenderer } from '../../rendering/rowRenderer';
import type { SpannedRowRenderer } from '../../rendering/spanning/spannedRowRenderer';
import { ViewportSizeFeature } from '../viewportSizeFeature';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export type RowContainerName = 'scrolling' | 'pinnedTop' | 'pinnedBottom' | 'stickyTop' | 'stickyBottom';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export type RowContainerType = 'center';
type GetRowCtrls = (renderer: RowRenderer) => RowCtrl[];
type GetSpannedRowCtrls = (renderer: SpannedRowRenderer) => RowCtrl[];
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export type RowContainerOptions = {
    type: RowContainerType;
    name: string;
    getRowCtrls: GetRowCtrls;
    getSpannedRowCtrls?: GetSpannedRowCtrls;
};
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _getRowContainerClass(name: RowContainerName): `ag-${string}`;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _getRowSpanContainerClass(name: RowContainerName): `ag-${string}-spanned-cells-container`;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _getRowContainerOptions(name: RowContainerName): RowContainerOptions;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export interface IRowContainerComp {
    setRowCtrls(params: {
        rowCtrls: RowCtrl[];
        useFlushSync?: boolean;
    }): void;
    setSpannedRowCtrls(rowCtrls: RowCtrl[], useFlushSync: boolean): void;
    setDomOrder(domOrder: boolean): void;
    setContainerWidth(width: string): void;
    setOffsetTop(offset: string): void;
    setHidden(hidden: boolean): void;
}
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class RowContainerCtrl extends BeanStub {
    private readonly name;
    private readonly options;
    private comp;
    eContainer: HTMLElement;
    eViewport: HTMLElement;
    viewportSizeFeature: ViewportSizeFeature | undefined;
    private readonly EMPTY_CTRLS;
    constructor(name: RowContainerName);
    postConstruct(): void;
    private onStickyTopOffsetChanged;
    private registerWithCtrlsService;
    private isScrollingCenterContainer;
    private isContainer;
    setComp(view: IRowContainerComp, eContainer: HTMLElement, eSpannedContainer: HTMLElement | undefined, eViewport: HTMLElement): void;
    private updateContainerWidth;
    private addListeners;
    private listenOnDomOrder;
    onDisplayedColumnsChanged(): void;
    private addPreventScrollWhileDragging;
    registerViewportResizeListener(listener: () => void): void;
    isViewportInTheDOMTree(): boolean;
    setContainerHeight(height: number): void;
    setContainerTop(top: number): void;
    private onDisplayedRowsChanged;
}
export {};
