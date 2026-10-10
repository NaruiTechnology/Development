import { BeanStub } from '../context/beanStub';
export declare class GridHeaderComp extends BeanStub {
    private readonly eTopSection;
    private readonly eGridViewport;
    private gridHeaderCtrl;
    private readonly eHeaderWrapper;
    constructor(eTopSection: HTMLElement, eGridViewport: HTMLElement);
    postConstruct(): void;
    destroy(): void;
}
