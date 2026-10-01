import type { AgColumn } from '../entities/agColumn';
import type { ColumnEventType } from '../events';
import type { ColumnChangedEventType } from '../interfaces/iColsService';
import type { IEventService } from '../interfaces/iEventService';
export declare function dispatchColumnPinnedEvent(eventSvc: IEventService, changedColumns: AgColumn[], source: ColumnEventType): void;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function dispatchColumnVisibleEvent(eventSvc: IEventService, changedColumns: AgColumn[], source: ColumnEventType): void;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare function _dispatchColumnChangedEvent<T extends ColumnChangedEventType>(eventSvc: IEventService, type: T, columns: AgColumn[], source: ColumnEventType): void;
export declare function dispatchColumnResizedEvent(eventSvc: IEventService, columns: AgColumn[] | null, finished: boolean, source: ColumnEventType, flexColumns?: AgColumn[] | null): void;
