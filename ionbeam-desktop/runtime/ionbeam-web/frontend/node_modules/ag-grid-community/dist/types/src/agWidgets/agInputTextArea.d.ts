import type { AgComponentSelector, AgCoreBeanCollection, BaseEvents, BaseProperties, IPropertiesService } from 'ag-stack';
import { AgAbstractInputField } from './agAbstractInputField';
import type { AgInputFieldParams } from './agFieldParams';
import type { AgWidgetSelectorType } from './agWidgetSelectorType';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class AgInputTextArea<TBeanCollection extends AgCoreBeanCollection<TProperties, TGlobalEvents, TCommon, TPropertiesService>, TProperties extends BaseProperties, TGlobalEvents extends BaseEvents, TCommon, TPropertiesService extends IPropertiesService<TProperties, TCommon>, TComponentSelectorType extends string> extends AgAbstractInputField<TBeanCollection, TProperties, TGlobalEvents, TCommon, TPropertiesService, TComponentSelectorType, HTMLTextAreaElement, string> {
    constructor(config?: AgInputFieldParams<TComponentSelectorType>);
    setValue(value: string, silent?: boolean): this;
    setCols(cols: number): this;
    setRows(rows: number): this;
}
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const AgInputTextAreaSelector: AgComponentSelector<AgWidgetSelectorType>;
