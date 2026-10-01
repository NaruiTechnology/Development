import type { ILocaleService, LocaleTextFunc } from 'ag-stack';
import type { NamedBean } from '../../context/bean';
import { BeanStub } from '../../context/beanStub';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class LocaleService extends BeanStub implements NamedBean, ILocaleService {
    beanName: "localeSvc";
    getLocaleTextFunc(): LocaleTextFunc;
}
