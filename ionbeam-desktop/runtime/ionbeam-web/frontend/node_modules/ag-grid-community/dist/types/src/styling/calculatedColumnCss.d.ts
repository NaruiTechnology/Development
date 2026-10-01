import type { AgColumn } from '../entities/agColumn';
import type { ICalculatedColumnsService } from '../interfaces/iCalculatedColumns';
export declare const CSS_CALCULATED_COLUMN = "ag-calculated-column";
export declare const CSS_CALCULATED_COLUMN_HIGHLIGHTED = "ag-calculated-column-highlighted";
export declare function _getCalculatedColumnCssClasses(column: AgColumn | null | undefined, calculatedColsSvc: ICalculatedColumnsService | undefined): readonly string[];
