import type { NamedBean } from './context/bean';
import { BeanStub } from './context/beanStub';
import type { FakeHScrollComp } from './gridBodyComp/fakeHScrollComp';
import type { FakeVScrollComp } from './gridBodyComp/fakeVScrollComp';
import type { GridBodyCtrl } from './gridBodyComp/gridBodyCtrl';
import type { GridBodyScrollFeature } from './gridBodyComp/gridBodyScrollFeature';
import type { RowContainerCtrl } from './gridBodyComp/rowContainer/rowContainerCtrl';
import type { GridCtrl } from './gridComp/gridCtrl';
import type { GridHeaderCtrl } from './headerRendering/gridHeaderCtrl';
import type { HeaderRowContainerCtrl } from './headerRendering/rowContainer/headerRowContainerCtrl';
/** If adding or removing a control, update `REQUIRED_CTRLS` below. */
interface ReadyParams {
    gridCtrl: GridCtrl;
    gridBodyCtrl: GridBodyCtrl;
    scrolling: RowContainerCtrl;
    pinnedTop: RowContainerCtrl;
    pinnedBottom: RowContainerCtrl;
    stickyTop: RowContainerCtrl;
    stickyBottom: RowContainerCtrl;
    fakeHScrollComp: FakeHScrollComp;
    fakeVScrollComp: FakeVScrollComp;
    gridHeaderCtrl: GridHeaderCtrl;
    headerRowContainerCtrl: HeaderRowContainerCtrl;
}
type CtrlType = keyof ReadyParams;
type BeanDestroyFunc = Pick<BeanStub<any>, 'addDestroyFunc'>;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class CtrlsService extends BeanStub<'ready'> implements NamedBean {
    beanName: "ctrlsSvc";
    private params;
    private ready;
    private readonly readyCallbacks;
    postConstruct(): void;
    private updateReady;
    whenReady(caller: BeanDestroyFunc, callback: (p: ReadyParams) => void): void;
    register<K extends CtrlType, T extends ReadyParams[K]>(ctrlType: K, ctrl: T): void;
    get<K extends CtrlType>(ctrlType: K): ReadyParams[K];
    getGridBodyCtrl(): GridBodyCtrl;
    getHeaderRowContainerCtrl(): HeaderRowContainerCtrl | undefined;
    getScrollFeature(): GridBodyScrollFeature;
}
export {};
