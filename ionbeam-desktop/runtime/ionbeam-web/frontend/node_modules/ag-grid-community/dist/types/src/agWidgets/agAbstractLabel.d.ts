import type { AgComponentEvent, AgComponentSelector, AgCoreBeanCollection, AgElementParams, BaseEvents, BaseProperties, IPropertiesService } from 'ag-stack';
import { AgComponentStub } from 'ag-stack';
import type { AgLabelParams, LabelAlignment } from './agFieldParams';
type AgAbstractLabelEvent = AgComponentEvent;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare abstract class AgAbstractLabel<TBeanCollection extends AgCoreBeanCollection<TProperties, TGlobalEvents, TCommon, TPropertiesService>, TProperties extends BaseProperties, TGlobalEvents extends BaseEvents, TCommon, TPropertiesService extends IPropertiesService<TProperties, TCommon>, TComponentSelectorType extends string, TConfig extends AgLabelParams = AgLabelParams, TEventType extends string = AgAbstractLabelEvent> extends AgComponentStub<TBeanCollection, TProperties, TGlobalEvents, TCommon, TPropertiesService, TComponentSelectorType, TEventType | AgAbstractLabelEvent> {
    protected abstract eLabel: HTMLElement;
    protected readonly config: TConfig;
    protected labelSeparator: string;
    protected labelAlignment: LabelAlignment;
    protected disabled: boolean;
    private label;
    constructor(config?: TConfig, template?: string | AgElementParams<TComponentSelectorType>, components?: AgComponentSelector<TComponentSelectorType>[]);
    postConstruct(): void;
    protected refreshLabel(): void;
    setLabelSeparator(labelSeparator: string): this;
    getLabelId(): string;
    getLabel(): HTMLElement | string;
    setLabel(label: HTMLElement | string): this;
    setLabelAlignment(alignment: LabelAlignment): this;
    setLabelEllipsis(hasEllipsis: boolean): this;
    setLabelWidth(width: number | 'flex'): this;
    setDisabled(disabled: boolean): this;
    isDisabled(): boolean;
}
export {};
