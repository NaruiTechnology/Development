/**
 * This function provides fuzzy matching suggestions based on the input value and a list of all suggestions.
 * @internal AG_GRID_INTERNAL - Not for public use. Can change / be removed at any time.
 */
export declare function _fuzzySuggestions(params: {
    inputValue: string;
    allSuggestions: string[];
    hideIrrelevant?: boolean;
    maxSuggestions?: number;
}): {
    values: string[];
    indices: number[];
};
/**
 * This uses Levenshtein Distance to match strings.
 * Lower values mean more similar strings.
 *
 * This function is often being called, so it must be performant.
 * {@link|https://github.com/ag-grid/ag-grid/issues/12473}
 * @knipIgnore Used in tests
 */
export declare function _getLevenshteinSimilarityDistance(source: string, target: string): number;
