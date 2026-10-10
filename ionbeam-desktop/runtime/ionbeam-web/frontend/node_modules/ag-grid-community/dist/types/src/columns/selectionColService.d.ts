import type { NamedBean } from '../context/bean';
import type { ColKind } from '../entities/agColumn';
import type { ColDef } from '../entities/colDef';
import type { PropertyValueChangedEvent } from '../gridOptionsService';
import { BaseSingleColService } from './baseSingleColService';
export declare class SelectionColService extends BaseSingleColService implements NamedBean {
    beanName: "selectionColSvc";
    protected readonly colKind: ColKind;
    postConstruct(): void;
    updateColumns(event: PropertyValueChangedEvent<'selectionColumnDef'>): void;
    isEnabled(): boolean;
    protected createColDef(): ColDef;
    private onSelectionOptionsChanged;
}
