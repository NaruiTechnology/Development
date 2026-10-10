import type { TabGuardCtrlParams } from 'ag-stack';
import { AgTabGuardCtrl, AgTabGuardFeature } from 'ag-stack';
import type { BeanCollection } from '../context/context';
import type { AgEventTypeParams } from '../events';
import type { GridOptionsWithDefaults } from '../gridOptionsDefault';
import type { GridOptionsService } from '../gridOptionsService';
import type { AgGridCommon } from '../interfaces/iCommon';
import type { Component } from './component';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class TabGuardCtrl extends AgTabGuardCtrl<BeanCollection, GridOptionsWithDefaults, AgEventTypeParams, AgGridCommon<any, any>, GridOptionsService> {
    constructor(params: TabGuardCtrlParams);
}
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare class TabGuardFeature extends AgTabGuardFeature<BeanCollection, GridOptionsWithDefaults, AgEventTypeParams, AgGridCommon<any, any>, GridOptionsService> {
    constructor(comp: Component<any>);
}
