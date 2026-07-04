/**
 * Help body wrapper for the vector "Fallback pixel blank" setting.
 * The actual content comes from the locale-aware help registry.
 */
import { useHelpBody } from "../i18n/help";

export function VectorPixelFallbackBlankHelp() {
  return useHelpBody("vectorPixelFallbackBlank");
}
