import type { NamedBean } from '../context/bean';
import { BeanStub } from '../context/beanStub';
import type { BeanCollection } from '../context/context';
import type { ColDef, ColGroupDef } from '../entities/colDef';
/** @knipIgnore Used in tests */
export declare function _deepCloneDefinition<T>(object: T, rootKeyToSkip?: string): T | undefined;
export declare class ColumnDefFactory extends BeanStub implements NamedBean {
    beanName: "colDefFactory";
    private colModel;
    wireBeans(beans: BeanCollection): void;
    /** Snapshot of the column tree as `ColDef[] | ColGroupDef[]`, display-ordered. Backs `getColumnDefs`. */
    getColumnDefs(): (ColDef | ColGroupDef)[] | undefined;
}
