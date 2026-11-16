/*
 * dfo-dps - tiny dependency-free SVG line charts for the single-file reports.
 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#c08a3e', '#7fae6a', '#c25b4e', '#6fa8dc', '#c9a0dc', '#e0d36a', '#8fd3c7', '#d98cb3'];

export function lineChart({ title, xLabel, yLabel, series, width = 920, height = 430, xTicks = null, yTicks = null, invertY = false }) {
  const legendCols = 5;
  const legendRows = Math.max(1, Math.ceil(series.length / legendCols));
  const left = 64, right = 24, top = 46 + (legendRows - 1) * 16, bottom = 54;
  const w = width - left - right, h = height - top - bottom;
  const all = series.flatMap((s) => s.points.map((p) => p.y));
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMax = Math.max(1, ...all) * 1.08;
  const sx = (x) => left + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * w;
  // `invertY` puts a small value at the TOP (a rank of 1 is the best); `yTicks` names the grid values.
  const sy = (y) => (invertY ? top + (y / yMax) * h : top + h - (y / yMax) * h);
  const grid = [];
  const yGrid = yTicks ?? Array.from({ length: 6 }, (_, i) => {
    const v = yMax * (1 - i / 5);
    return { y: v, label: v.toFixed(v >= 100 ? 0 : 1) };
  });
  for (const tick of yGrid) {
    const y = sy(tick.y);
    grid.push(`<line x1="${left}" y1="${y}" x2="${left + w}" y2="${y}" stroke="#3a3026" stroke-width="1"/>`);
    grid.push(`<text x="${left - 8}" y="${y + 4}" fill="#a8a092" font-size="11" text-anchor="end">${esc(tick.label)}</text>`);
  }
  // Explicit ticks name the x values (`[{ x, label }]`); without them the axis stays numeric and evenly divided.
  const ticks = xTicks ?? Array.from({ length: 6 }, (_, i) => {
    const x = xMin + ((xMax - xMin) * i) / 5;
    return { x, label: x.toFixed(x % 1 ? 1 : 0) };
  });
  for (const tick of ticks) {
    const x = sx(tick.x);
    grid.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${top + h}" stroke="#2b241c" stroke-width="1"/>`);
    grid.push(`<text x="${x}" y="${top + h + 20}" fill="#a8a092" font-size="11" text-anchor="middle">${esc(tick.label)}</text>`);
  }
  const lines = series.map((s, i) => {
    const pts = s.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    const dots = s.points.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2.2" fill="${COLORS[i % COLORS.length]}"><title>${esc(s.name)} ${p.x}: ${p.y.toFixed(2)}</title></circle>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="2"/>${dots}`;
  }).join('');
  const legend = series.map((s, i) => {
    const col = i % legendCols, row = Math.floor(i / legendCols);
    return `<g transform="translate(${left + col * 170}, ${top - 18 - row * 16})"><rect width="10" height="10" fill="${COLORS[i % COLORS.length]}"/><text x="15" y="9" fill="#e9e4d9" font-size="12">${esc(s.name)}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}" style="display:block;max-width:100%;height:auto">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#12100e"/>
    <text x="${left}" y="22" fill="#e0b76a" font-size="16" font-family="Georgia,serif">${esc(title)}</text>
    <text x="${left}" y="${top + h + 44}" fill="#a8a092" font-size="12">${esc(xLabel)}</text>
    <text x="14" y="${top + h / 2}" fill="#a8a092" font-size="12" transform="rotate(-90 14 ${top + h / 2})">${esc(yLabel)}</text>
    ${grid.join('')}${lines}${legend}
  </svg>`;
}

export function graphPage({ title, subtitle, chart }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#12100e;color:#e9e4d9;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1040px;margin:0 auto;padding:28px 20px 60px}h1{font:600 26px/1.15 Georgia,serif;color:#e0b76a;margin:0 0 4px}p{color:#a8a092;margin:0 0 18px}.panel{background:#1b1814;border:1px solid #3a3026;border-radius:8px;padding:14px}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(subtitle)}</p><div class="panel">${chart}</div></main></body></html>`;
}


/** A page of several labelled charts, each with its own note. */
export function multiGraphPage({ title, subtitle, sections, width = 1100 }) {
  const body = sections.map((s) => `<section class="panel"><h2>${esc(s.title)}</h2>${s.note ? `<p class="note">${s.note}</p>` : ''}${s.chart}${s.table ? `<div class="table">${s.table}</div>` : ''}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  body{margin:0;background:#12100e;color:#e9e4d9;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
  main{max-width:${width}px;margin:0 auto;padding:30px 20px 70px}
  h1{font:600 28px/1.15 Georgia,serif;color:#e0b76a;margin:0 0 6px}
  h2{font:600 18px/1.2 Georgia,serif;color:#e0b76a;margin:0 0 6px}
  p{color:#a8a092;margin:0 0 16px}
  .panel{background:#1b1814;border:1px solid #3a3026;border-radius:8px;padding:16px;margin:18px 0}
  .note{font-size:13px;color:#a8a092;margin:0 0 12px}
  .note b{color:#e9e4d9}
  .table{overflow-x:auto;margin-top:12px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #3a3026;white-space:nowrap}
  th{color:#a8a092;font-weight:500}
  td:not(:first-child){text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e0b76a}
  .k{color:#e9e4d9}
</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(subtitle)}</p>${body}</main></body></html>`;
}


/** A horizontal grouped bar chart: one label per row, one thin bar per series. */
export function barChart({ title, labels, series, width = 920, unit = '' }) {
  const left = 170, right = 70, top = 48, rowH = 26, bottom = 24;
  const height = top + labels.length * rowH + bottom;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const w = width - left - right;
  const sx = (v) => left + (v / max) * w;
  const rows = labels.map((label, i) => {
    const y = top + i * rowH;
    const n = series.length;
    const bh = Math.max(3, (rowH - 7) / n - 1);
    const bars = series.map((s, j) => {
      const val = s.values[i];
      const by = y + 3 + j * (bh + 1);
      const bw = Math.max(1, sx(val) - left);
      return `<rect x="${left}" y="${by}" width="${bw}" height="${bh}" fill="${COLORS[j % COLORS.length]}" rx="2"/><text x="${left + bw + 6}" y="${by + bh - 1}" fill="#a8a092" font-size="10">${val.toFixed(0)}${esc(unit)}</text>`;
    }).join('');
    return `<text x="${left - 8}" y="${y + rowH / 2 + 4}" fill="#e9e4d9" font-size="11" text-anchor="end">${esc(label)}</text>${bars}`;
  }).join('');
  const legend = series.map((s, j) => `<g transform="translate(${left + j * 190}, ${top - 20})"><rect width="10" height="10" fill="${COLORS[j % COLORS.length]}"/><text x="15" y="9" fill="#e9e4d9" font-size="12">${esc(s.name)}</text></g>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}" style="display:block;max-width:100%;height:auto">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#12100e"/>
    <text x="${left}" y="24" fill="#e0b76a" font-size="16" font-family="Georgia,serif">${esc(title)}</text>
    ${legend}${rows}
  </svg>`;
}
