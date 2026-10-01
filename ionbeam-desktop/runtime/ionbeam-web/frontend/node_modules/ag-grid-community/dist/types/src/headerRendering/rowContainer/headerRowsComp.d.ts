import { BeanStub } from '../../context/beanStub';
export declare class HeaderRowsComp extends BeanStub {
    private readonly eHeaderWrapper;
    private readonly eGridViewport;
    private readonly setHeaderRowFocusableElements;
    private headerRowComps;
    constructor(eHeaderWrapper: HTMLElement, eGridViewport: HTMLElement, setHeaderRowFocusableElements: (elements: HTMLElement[]) => void);
    postConstruct(): void;
    destroy(): void;
    private destroyRowComp;
    private setCtrls;
}
