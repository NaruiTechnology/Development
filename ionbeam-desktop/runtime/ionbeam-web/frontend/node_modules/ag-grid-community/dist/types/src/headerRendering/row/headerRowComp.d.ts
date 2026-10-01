import { Component } from '../../widgets/component';
import type { HeaderRowCtrl } from './headerRowCtrl';
export type HeaderRowType = 'group' | 'column' | 'filter';
export declare class HeaderRowComp extends Component {
    private readonly ctrl;
    private headerComps;
    private readonly ePinnedLeftCells;
    private readonly ePinnedLeftWrapper;
    private readonly eScrollingCells;
    private readonly ePinnedRightCells;
    private readonly ePinnedRightWrapper;
    private readonly pinnedWidthsCache;
    constructor(ctrl: HeaderRowCtrl);
    postConstruct(): void;
    destroy(): void;
    private setHeaderCtrls;
    private getHeaderCellGroup;
    private updatePinnedCellGroupWidths;
    private setRowIndex;
    private createHeaderComp;
}
