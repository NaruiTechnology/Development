import type { BeanCollection } from '../context/context';
import { Component } from '../widgets/component';
export declare class RowSummaryComp extends Component {
    private pagination;
    private readonly lbFirstRowOnPage;
    private readonly lbLastRowOnPage;
    private readonly lbRecordCount;
    ariaStatus: string;
    private readonly idPrefix;
    constructor(idPrefix: string);
    wireBeans(beans: BeanCollection): void;
    postConstruct(): void;
    private isZeroPages;
    refresh(): void;
}
