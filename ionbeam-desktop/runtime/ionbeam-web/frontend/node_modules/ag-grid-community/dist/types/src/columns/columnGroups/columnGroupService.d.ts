import type { NamedBean } from '../../context/bean';
import { BeanStub } from '../../context/beanStub';
import type { BeanCollection } from '../../context/context';
import type { AgColumn } from '../../entities/agColumn';
import { AgColumnGroup } from '../../entities/agColumnGroup';
import type { ColumnPinnedType } from '../../interfaces/iColumn';
import type { GroupInstanceIdCreator } from '../groupInstanceIdCreator';
import { ColWrapperCache } from './colWrapperCache';
export declare class ColumnGroupService extends BeanStub implements NamedBean {
    beanName: "colGroupSvc";
    private colModel;
    private colViewport;
    /** Cache service-column wrappers (auto-group/selection/row-numbers) across `refreshCols` by `(col, depth)`. */
    wrapperCache: ColWrapperCache;
    wireBeans(beans: BeanCollection): void;
    destroy(): void;
    /** Build one pinned section's displayed group tree from already-sorted `columns`.
     *  @param buildToken Stamp reused/created groups for `prune` to drop stale tail entries.
     *  @param isStandaloneStructure Build detached output (e.g. exports) without reuse, bean registration, or parent wiring. */
    createGroups(columns: AgColumn[], idCreator: GroupInstanceIdCreator, pinned: ColumnPinnedType, buildToken?: number, isStandaloneStructure?: boolean): (AgColumn | AgColumnGroup)[];
    /** Finalise display instances by keeping groups stamped with `buildToken` and truncating stale tail entries. */
    prune(buildToken: number): void;
}
