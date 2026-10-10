import { BeanStub } from '../context/beanStub';
import type { Column, ColumnGroupShowType, ColumnInstanceId, ProvidedColumnGroup } from '../interfaces/iColumn';
import type { AgColumn } from './agColumn';
import type { AgColumnGroup } from './agColumnGroup';
import type { ColGroupDef } from './colDef';
export declare function isProvidedColumnGroup(col: Column | ProvidedColumnGroup | string | null | undefined): col is AgProvidedColumnGroup;
export type AgProvidedColumnGroupEvent = 'expandedChanged' | 'expandableChanged';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class AgProvidedColumnGroup extends BeanStub<AgProvidedColumnGroupEvent> implements ProvidedColumnGroup {
    colGroupDef: ColGroupDef | null;
    readonly groupId: string;
    readonly padding: boolean;
    level: number;
    readonly isColumn: false;
    originalParent: AgProvidedColumnGroup | null;
    children: (AgColumn | AgProvidedColumnGroup)[];
    expandable: boolean;
    expanded: boolean;
    /** Most recent build token that claimed this group — detects "already used in this refresh". */
    buildToken: number;
    /** Packed `AgColumnGroup` display instances by dense per-refresh `partId` (`displayInstances[0]` is primary), lazily allocated and pruned by `columnGroupService`. */
    displayInstances: AgColumnGroup[] | null;
    /** Cache previous `setExpandable` visibility so `AgColumn.setVisible` ancestor walk can stop when unchanged. */
    private lastVisible;
    readonly instanceId: ColumnInstanceId;
    constructor(colGroupDef: ColGroupDef | null, groupId: string, padding: boolean, level: number);
    getInstanceId(): ColumnInstanceId;
    getOriginalParent(): AgProvidedColumnGroup | null;
    getLevel(): number;
    /** Visible iff at least one child is visible. */
    isVisible(): boolean;
    isPadding(): boolean;
    setExpanded(expanded: boolean | undefined): boolean;
    isExpandable(): boolean;
    isExpanded(): boolean;
    getGroupId(): string;
    getId(): string;
    getChildren(): (AgColumn | AgProvidedColumnGroup)[];
    getColGroupDef(): ColGroupDef | null;
    getLeafColumns(): AgColumn[];
    private addLeafColumns;
    getColumnGroupShow(): ColumnGroupShowType | undefined;
    /** Recompute child-driven expandability and return whether `AgColumn.setVisible` should continue ancestor walking. */
    setExpandable(): boolean;
}
