import type { ColorValue } from './themeTypes';
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const paramToVariableName: (paramName: string) => string;
export declare const paramToVariableExpression: (paramName: string) => string;
export declare const clamp: (value: number, min: number, max: number) => number;
export declare const memoize: <R, A = void>(fn: (arg: A) => R) => ((arg: A) => R);
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const accentMix: (mix: number) => ColorValue;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const foregroundMix: (mix: number) => ColorValue;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const foregroundBackgroundMix: (mix: number) => ColorValue;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const foregroundHeaderBackgroundMix: (mix: number) => ColorValue;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const backgroundColor: ColorValue;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const foregroundColor: ColorValue;
/** @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time. */
export declare const accentColor: ColorValue;
