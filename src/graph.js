/*
 * dfo-dps - tiny dependency-free SVG line charts for the single-file reports.
 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#c08a3e', '#7fae6a', '#c25b4e', '#6fa8dc', '#c9a0dc'];

export function lineChart({ title, xLabel, yLabel, series, width = 920, height = 430 }) {
  const left = 64, right = 24, top = 46, bottom = 54;
  const w = width - left - right, h = height - top - bottom;
  const all = series.flatMap((s) => s.points.map((p) => p.y));
  const xs = series.flatMap((s) => s.points.map((p) => p.x));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = 0;
  const yMax = Math.max(1, ...all) * 1.08;
  const sx = (x) => left + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * w;
  const sy = (y) => top + h - (y / yMax) * h;
  const grid = [];
  for (let i = 0; i <= 5; i++) {
    const y = top + (h * i) / 5;
    const v = yMax * (1 - i / 5);
    grid.push(`<line x1="${left}" y1="${y}" x2="${left + w}" y2="${y}" stroke="#3a3026" stroke-width="1"/>`);
    grid.push(`<text x="${left - 8}" y="${y + 4}" fill="#a8a092" font-size="11" text-anchor="end">${v.toFixed(v >= 100 ? 0 : 1)}</text>`);
  }
  for (let i = 0; i <= 5; i++) {
    const x = left + (w * i) / 5;
    const v = xMin + ((xMax - xMin) * i) / 5;
    grid.push(`<line x1="${x}" y1="${top}" x2="${x}" y2="${top + h}" stroke="#2b241c" stroke-width="1"/>`);
    grid.push(`<text x="${x}" y="${top + h + 20}" fill="#a8a092" font-size="11" text-anchor="middle">${v.toFixed(v % 1 ? 1 : 0)}</text>`);
  }
  const lines = series.map((s, i) => {
    const pts = s.points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    const dots = s.points.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2.2" fill="${COLORS[i % COLORS.length]}"><title>${esc(s.name)} ${p.x}: ${p.y.toFixed(2)}</title></circle>`).join('');
    return `<polyline points="${pts}" fill="none" stroke="${COLORS[i % COLORS.length]}" stroke-width="2"/>${dots}`;
  }).join('');
  const legend = series.map((s, i) => `<g transform="translate(${left + i * 190}, ${top - 18})"><rect width="10" height="10" fill="${COLORS[i % COLORS.length]}"/><text x="15" y="9" fill="#e9e4d9" font-size="12">${esc(s.name)}</text></g>`).join('');
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
