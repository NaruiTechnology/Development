import type { NamedBean } from '../context/bean';
import { BeanStub } from '../context/beanStub';
import type { BeanCollection } from '../context/context';
import type { ClientSideRowModelStage } from '../interfaces/iClientSideRowModel';
import type { IRowNodeFilterStage } from '../interfaces/iRowNodeStage';
export declare class FilterStage extends BeanStub implements IRowNodeFilterStage, NamedBean {
    beanName: "filterStage";
    readonly step: ClientSideRowModelStage;
    readonly refreshProps: null;
    private filterManager?;
    wireBeans(beans: BeanCollection): void;
    execute(): void;
}
