import type { NamedBean } from '../context/bean';
import { BeanStub } from '../context/beanStub';
import type { BeanCollection } from '../context/context';
import type { RowNode } from '../entities/rowNode';
import type { SortOption } from '../interfaces/iSortOption';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class RowNodeSorter extends BeanStub implements NamedBean {
    beanName: "rowNodeSorter";
    private accentedSort;
    private primaryColumnsSortGroups;
    private pivotActive;
    private firstLeaf;
    private colModel;
    private formula;
    private valueSvc;
    postConstruct(): void;
    wireBeans(beans: BeanCollection): void;
    doFullSortInPlace(rowNodes: RowNode[], sortOptions: SortOption[]): RowNode[];
    compareRowNodes(sortOptions: SortOption[], nodeA: RowNode, nodeB: RowNode): number;
    private getValue;
    private getGroupDataValue;
}
