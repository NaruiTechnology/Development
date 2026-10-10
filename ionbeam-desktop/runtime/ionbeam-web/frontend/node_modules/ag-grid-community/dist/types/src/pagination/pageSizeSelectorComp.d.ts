import type { BeanCollection } from '../context/context';
import type { PageSizePanelParams } from '../entities/gridOptions';
import { Component } from '../widgets/component';
export declare class PageSizeSelectorComp extends Component {
    private readonly panelParams?;
    private pagination;
    wireBeans(beans: BeanCollection): void;
    private selectPageSizeComp;
    private hasEmptyOption;
    private pageSizeOptions?;
    constructor(panelParams?: PageSizePanelParams | undefined);
    private getPageSizeSelectorOption;
    postConstruct(): void;
    private readonly handlePageSizeItemSelected;
    private handlePaginationChanged;
    toggleSelectDisplay(show: boolean): void;
    private reset;
    private onPageSizeSelectorValuesChange;
    shouldShowPageSizeSelector(): boolean;
    updateVisibility(): void;
    private reloadPageSizesSelector;
    private createPageSizeSelectOptions;
    private createPageSizeSelectorComp;
    private getPageSizeSelectorValues;
    destroy(): void;
}
