/**
 * Small, safe Markdown subset for chat replies: paragraphs, bullet and numbered lists,
 * tables, **bold**, *italic* and `code`. The input is escaped first, so model output
 * cannot inject HTML.
 */

/** Escape text for use in HTML content and attribute values. */
export function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const BULLET = /^(\*|-|•)\s+/;
const NUMBERED = /^\d+[.)]\s+/;
const TABLE_ROW = /^\|.*\|$/;
const TABLE_DIVIDER = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

/** Inline formatting on already-escaped text: **bold**, *italic* and `code`. */
function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?![*\w])/g, '$1<em>$2</em>');
}

const cells = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));

/** Render a Markdown table (header row, divider row, body rows). */
function renderTable(rows) {
  const [head, , ...body] = rows;
  const th = cells(head).map((c) => `<th>${c}</th>`).join('');
  const tr = body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

/** Convert a model reply to HTML. */
export function formatTextToHtml(text) {
  const lines = escapeHtml(text).split(/\r?\n/).map((l) => l.trim());

  let html = '';
  let list = null; // 'ul' | 'ol' | null
  let pendingBreak = false;

  const open = (tag) => {
    if (list === tag) return;
    if (list) html += `</${list}>`;
    html += `<${tag}>`;
    list = tag;
  };
  const close = () => {
    if (list) html += `</${list}>`;
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      pendingBreak = true;
      continue;
    }

    // Tables: some models (e.g. gpt-oss) answer list questions with a Markdown table.
    if (TABLE_ROW.test(line) && TABLE_DIVIDER.test(lines[i + 1] ?? '')) {
      close();
      const rows = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(lines[i++]);
      i--;
      html += renderTable(rows);
      pendingBreak = false;
      continue;
    }

    const isList = BULLET.test(line) || NUMBERED.test(line);
    // A blank line ends a list only when normal text follows, so loose lists stay one list.
    if (pendingBreak && !isList) close();
    pendingBreak = false;

    if (BULLET.test(line)) {
      open('ul');
      html += `<li>${inline(line.replace(BULLET, ''))}</li>`;
    } else if (NUMBERED.test(line)) {
      // Drop the model's own numbering so <ol> numbers the items.
      open('ol');
      html += `<li>${inline(line.replace(NUMBERED, ''))}</li>`;
    } else {
      close();
      html += `<p>${inline(line)}</p>`;
    }
  }
  close();
  return html;
}

/** Format metres as "850 m" or "1.25 km". */
export const formatDistance = (m) => (m == null ? '' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
