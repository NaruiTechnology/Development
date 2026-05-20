/**
 * Help body dispatcher.
 *
 * The help components import `useHelpBody` instead of inlining their
 * content; this hook returns the JSX body for the current locale. We
 * keep three locale files (en.tsx / zh-CN.tsx / zh-TW.tsx) imported
 * eagerly because together they're under 30 KB gzipped — smaller than
 * one frame of canvas pixels — so dynamic-import / Suspense plumbing
 * would cost more (in code and in first-paint flicker on language
 * switch) than it saves.
 */
import type { ReactNode } from "react";

import { useTranslation } from "../index";

import { helpBodies as enBodies, type HelpKey } from "./en";
import { helpBodies as zhCNBodies } from "./zh-CN";
import { helpBodies as zhTWBodies } from "./zh-TW";

const REGISTRIES = {
  "en": enBodies,
  "zh-CN": zhCNBodies,
  "zh-TW": zhTWBodies,
};

export function useHelpBody(key: HelpKey): ReactNode {
  const { locale } = useTranslation();
  const registry = REGISTRIES[locale] ?? enBodies;
  const render = registry[key] ?? enBodies[key];
  // Per-render call: the body functions are pure & cheap (just
  // returning JSX), and calling them inside the help modal means a
  // language switch while the modal is open re-paints with the new
  // locale on the next render. No memoisation needed.
  return render();
}

export type { HelpKey } from "./en";
