import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { ImageWorkspace } from "../store/scanSlice";

/** Keep editable image controls independent while switching workspaces. */
export function useWorkspaceState<T>(
  workspace: ImageWorkspace,
  initialValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [values, setValues] = useState<Record<ImageWorkspace, T>>(() => ({
    scan: initialValue,
    processing: initialValue,
  }));
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValues((current) => {
      const value = typeof next === "function"
        ? (next as (previous: T) => T)(current[workspace])
        : next;
      return Object.is(value, current[workspace]) ? current : { ...current, [workspace]: value };
    });
  }, [workspace]);
  return [values[workspace], setValue];
}

/** Separate ref cells prevent late callbacks from touching another workspace. */
export function useWorkspaceRef<T>(workspace: ImageWorkspace, initialValue: T) {
  const [values] = useState(() => ({
    scan: { current: initialValue },
    processing: { current: initialValue !== null && typeof initialValue === "object"
      ? structuredClone(initialValue) : initialValue },
  }));
  return values[workspace];
}
