import type { BeanCollection } from '../context/context';
import type { ComponentSelector } from '../widgets/component';
import { AbstractFakeScrollComp } from './abstractFakeScrollComp';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class FakeHScrollComp extends AbstractFakeScrollComp {
    private visibleCols;
    private scrollVisibleSvc;
    wireBeans(beans: BeanCollection): void;
    private enableRtl;
    private readonly eEndSpacer;
    constructor();
    postConstruct(): void;
    destroy(): void;
    protected initialiseInvisibleScrollbar(): void;
    private refreshCompBottom;
    private setContainerWidth;
    private setScrollVisibleDebounce;
    protected setScrollVisible(): void;
    private getVerticalSpacerWidth;
    getScrollPosition(): number;
    setScrollPosition(value: number): void;
}
export declare const FakeHScrollSelector: ComponentSelector;
