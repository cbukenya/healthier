import React from 'react';
import { Label, Row } from './primitives';

/** An at-a-glance tile: the number, its verdict, a trend, then the details as label–value rows. */
export function Tile({ label, icon, value, pill, chart, rows, empty, note }: {
  label: string;
  icon: React.ReactNode;
  value: React.ReactNode;
  pill?: React.ReactNode;
  chart?: React.ReactNode;
  /** Rows without a value are left out. */
  rows: [string, string | false | null | undefined][];
  /** Shown instead when the tile has nothing to report. */
  empty?: string | null;
  note?: string | null;
}) {
  const shown = rows.filter((r): r is [string, string] => !!r[1]);
  return (
    <article className="min-w-0 bg-[#0c0c0e] border border-[#1e1e22] rounded-[18px] p-3.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="truncate">{label}</Label>
        {icon}
      </div>
      <div>{value}</div>
      {pill && <div className="flex">{pill}</div>}
      {chart}
      {shown.length > 0 && (
        <div>
          {shown.map(([k, v]) => <Row key={k} label={k} dense>{v}</Row>)}
        </div>
      )}
      {empty && <p className="text-[11.5px] leading-[1.5] text-zinc-500">{empty}</p>}
      {note && <p className="text-[10px] text-amber-400/80">{note}</p>}
    </article>
  );
}
