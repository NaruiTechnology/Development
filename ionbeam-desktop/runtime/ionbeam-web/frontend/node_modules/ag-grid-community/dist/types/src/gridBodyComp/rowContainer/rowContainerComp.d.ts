import type { ComponentSelector } from '../../widgets/component';
import { Component } from '../../widgets/component';
export declare class RowContainerComp extends Component {
    private readonly eContainer;
    private readonly eSpannedContainer;
    private readonly name;
    private readonly options;
    private rowCompsNoSpan;
    private rowCompsWithSpan;
    private domOrder;
    private lastPlacedElement;
    private initialised;
    constructor(params?: {
        name: string;
    });
    postConstruct(): void;
    private initialiseComp;
    destroy(): void;
    private setRowCtrls;
    private addRowNodes;
    private removeOldRows;
    private ensureDomOrder;
}
export declare const RowContainerSelector: ComponentSelector;
