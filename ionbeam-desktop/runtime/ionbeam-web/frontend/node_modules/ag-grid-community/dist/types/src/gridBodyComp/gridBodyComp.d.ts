import type { FocusableContainer } from '../interfaces/iFocusableContainer';
import type { ComponentSelector } from '../widgets/component';
import { Component } from '../widgets/component';
export declare class GridBodyComp extends Component implements FocusableContainer {
    private readonly eGridViewport;
    private readonly eGridScrollableArea;
    private readonly eTop;
    private readonly eTopExtraRows;
    private readonly eBottom;
    private readonly eBody;
    private readonly eScrollingRowContainer;
    private readonly ePinnedTopRowContainer;
    private readonly ePinnedBottomRowContainer;
    private ctrl;
    private pinnedSectionState;
    private stickyBottomRowsHeight;
    postConstruct(): void;
    private toggleClassForContainers;
    private setPinnedSection;
    private refreshBottomSectionHeight;
    getFocusableContainerName(): 'gridBody';
}
export declare const GridBodySelector: ComponentSelector;
