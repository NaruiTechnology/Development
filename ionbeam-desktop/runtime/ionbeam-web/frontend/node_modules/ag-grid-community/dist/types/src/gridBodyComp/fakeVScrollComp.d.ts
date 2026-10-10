import type { ComponentSelector } from '../widgets/component';
import { AbstractFakeScrollComp } from './abstractFakeScrollComp';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class FakeVScrollComp extends AbstractFakeScrollComp {
    private readonly eSpacer;
    private enableRtl;
    constructor();
    postConstruct(): void;
    protected setScrollVisible(): void;
    private onRowContainerHeightChanged;
    private queueContainerHeightSync;
    private syncContainerHeight;
    getScrollPosition(): number;
    setScrollPosition(value: number, force?: boolean): void;
}
export declare const FakeVScrollSelector: ComponentSelector;
