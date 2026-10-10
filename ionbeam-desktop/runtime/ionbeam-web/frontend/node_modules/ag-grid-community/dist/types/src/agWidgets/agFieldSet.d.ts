import type { AgBaseComponent, AgComponentSelector, AgCoreBeanCollection, BaseEvents, BaseProperties, IPropertiesService } from 'ag-stack';
import { AgAbstractLabel } from './agAbstractLabel';
import type { AgLabelParams } from './agFieldParams';
import type { AgWidgetSelectorType } from './agWidgetSelectorType';
type AgFieldSetItem<TBeanCollection> = AgBaseComponent<TBeanCollection> | HTMLElement;
type AgFieldSetDirection = 'horizontal' | 'vertical';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class AgFieldSet<TBeanCollection extends AgCoreBeanCollection<TProperties, TGlobalEvents, TCommon, TPropertiesService>, TProperties extends BaseProperties, TGlobalEvents extends BaseEvents, TCommon, TPropertiesService extends IPropertiesService<TProperties, TCommon>, TComponentSelectorType extends string, TConfig extends AgLabelParams = AgLabelParams> extends AgAbstractLabel<TBeanCollection, TProperties, TGlobalEvents, TCommon, TPropertiesService, TComponentSelectorType, TConfig> {
    protected readonly eLabel: HTMLElement;
    private readonly eWrapper;
    constructor(config?: TConfig);
    postConstruct(): void;
    addItems(items: AgFieldSetItem<TBeanCollection>[]): void;
    addItem(item: AgFieldSetItem<TBeanCollection>): void;
    setDirection(direction: AgFieldSetDirection): this;
}
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const AgFieldSetSelector: AgComponentSelector<AgWidgetSelectorType>;
export {};
