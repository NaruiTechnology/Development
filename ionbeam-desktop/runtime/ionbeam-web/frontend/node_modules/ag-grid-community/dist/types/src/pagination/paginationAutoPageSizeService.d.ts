import type { NamedBean } from '../context/bean';
import { BeanStub } from '../context/beanStub';
export declare class PaginationAutoPageSizeService extends BeanStub implements NamedBean {
    beanName: "paginationAutoPageSizeSvc";
    private scrollingRowsCtrl;
    private isBodyRendered;
    postConstruct(): void;
    private notActive;
    private onPaginationAutoSizeChanged;
    private checkPageSize;
}
