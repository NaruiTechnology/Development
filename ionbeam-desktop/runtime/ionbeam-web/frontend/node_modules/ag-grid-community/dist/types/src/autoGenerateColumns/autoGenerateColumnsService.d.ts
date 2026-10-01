import type { NamedBean } from '../context/bean';
import { BeanStub } from '../context/beanStub';
export declare class AutoGenerateColumnsService extends BeanStub implements NamedBean {
    beanName: "autoGenColsSvc";
    postConstruct(): void;
    private generateColumns;
}
