/** Navigation tree of parameter groups (with roll-up counts) and the table layouts inside them. */
import { useEffect, useMemo, useState } from "react";

import { useTranslation } from "../../i18n";
import { ancestorCodes, buildGroupTree, type GroupNode } from "../../lib/calibrationModel";
import type { CalibrationGroup } from "../../types/calibration";

export type TreeSelection = { kind: "group"; code: string | null } | { kind: "table"; code: string };

export function CalibrationTree({
  groups,
  selection,
  totals,
  onSelect,
}: {
  groups: CalibrationGroup[];
  selection: TreeSelection;
  totals: { definitions: number; undocumented: number; with_values: number };
  onSelect: (selection: TreeSelection) => void;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildGroupTree(groups), [groups]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  // keep the selected branch expanded
  useEffect(() => {
    const code = selection.kind === "group" ? selection.code : groups.find((g) => g.tables.some((x) => x.table_code === selection.code))?.group_code;
    if (!code) return;
    setOpen((prev) => new Set([...prev, ...ancestorCodes(groups, code)]));
  }, [selection, groups]);

  function toggle(code: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  return (
    <nav className="calib-tree" aria-label={t("calibration.tree.aria")}>
      <button
        type="button"
        className="calib-tree__item calib-tree__item--all"
        aria-current={selection.kind === "group" && selection.code === null ? "true" : undefined}
        onClick={() => onSelect({ kind: "group", code: null })}
      >
        <span className="calib-tree__label">{t("calibration.tree.all")}</span>
        <Counts values={totals.with_values} total={totals.definitions} undocumented={totals.undocumented} />
      </button>
      <ul role="tree" className="calib-tree__list">
        {tree.map((node) => (
          <TreeNode key={node.group.group_code} node={node} depth={0} open={open} selection={selection} onToggle={toggle} onSelect={onSelect} />
        ))}
      </ul>
    </nav>
  );
}

function Counts({ values, total, undocumented }: { values: number; total: number; undocumented: number }) {
  const { t } = useTranslation();
  return (
    <span className="calib-tree__counts">
      {undocumented > 0 && (
        <span className="calib-tree__warn" title={t("calibration.tree.undocumentedTitle", { count: undocumented })}>
          {undocumented}
        </span>
      )}
      <span title={t("calibration.tree.valuesTitle", { values, total })}>
        {values}/{total}
      </span>
    </span>
  );
}

function TreeNode({
  node,
  depth,
  open,
  selection,
  onToggle,
  onSelect,
}: {
  node: GroupNode;
  depth: number;
  open: Set<string>;
  selection: TreeSelection;
  onToggle: (code: string) => void;
  onSelect: (selection: TreeSelection) => void;
}) {
  const { group } = node;
  const expandable = node.children.length > 0 || group.tables.length > 0;
  const expanded = open.has(group.group_code);
  const total = group.total_parameters + group.total_table_cells;
  if (total === 0) return null;
  return (
    <li role="treeitem" aria-expanded={expandable ? expanded : undefined} aria-selected={selection.kind === "group" && selection.code === group.group_code}>
      <div className="calib-tree__row" style={{ paddingLeft: 6 + depth * 12 }}>
        {expandable ? (
          <button type="button" className="calib-tree__twisty" aria-label={group.label} onClick={() => onToggle(group.group_code)}>
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="calib-tree__twisty" />
        )}
        <button
          type="button"
          className="calib-tree__item"
          aria-current={selection.kind === "group" && selection.code === group.group_code ? "true" : undefined}
          onClick={() => {
            onSelect({ kind: "group", code: group.group_code });
            if (expandable && !expanded) onToggle(group.group_code);
          }}
        >
          <span className="calib-tree__label">{group.label}</span>
          <Counts values={group.total_with_values} total={total} undocumented={group.total_undocumented} />
        </button>
      </div>
      {expanded && (
        <ul role="group" className="calib-tree__list">
          {group.tables.map((table) => (
            <li key={table.table_code} role="treeitem">
              <div className="calib-tree__row" style={{ paddingLeft: 6 + (depth + 1) * 12 }}>
                <span className="calib-tree__twisty" />
                <button
                  type="button"
                  className="calib-tree__item calib-tree__item--table"
                  aria-current={selection.kind === "table" && selection.code === table.table_code ? "true" : undefined}
                  onClick={() => onSelect({ kind: "table", code: table.table_code })}
                >
                  <span className="calib-tree__label">▦ {table.label}</span>
                </button>
              </div>
            </li>
          ))}
          {node.children.map((child) => (
            <TreeNode key={child.group.group_code} node={child} depth={depth + 1} open={open} selection={selection} onToggle={onToggle} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}
