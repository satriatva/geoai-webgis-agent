import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatTextToHtml } from '../public/js/format.js';

test('escapes HTML in model output', () => {
  assert.equal(escapeHtml('<b onclick="x">'), '&lt;b onclick=&quot;x&quot;&gt;');
  assert.doesNotMatch(formatTextToHtml('<script>alert(1)</script>'), /<script>/);
});

test('renders lists, bold, italic and code', () => {
  const html = formatTextToHtml('**Hospitals**\n\n- RS A (745 m)\n- RS B\n\n*Straight-line distances.* Use `radius_m`.');
  assert.match(html, /<p><strong>Hospitals<\/strong><\/p><ul><li>RS A \(745 m\)<\/li><li>RS B<\/li><\/ul>/);
  assert.match(html, /<em>Straight-line distances.<\/em>/);
  assert.match(html, /<code>radius_m<\/code>/);
});

test('renders Markdown tables', () => {
  const html = formatTextToHtml('Hospitals:\n| # | Hospital | Distance |\n|---|---|---|\n| 1 | RS Gigi | 745 m |\n| 2 | RSUD Sardjito | 778 m |\nDone.');
  assert.match(html, /<table><thead><tr><th>#<\/th><th>Hospital<\/th><th>Distance<\/th><\/tr><\/thead>/);
  assert.equal((html.match(/<tr>/g) ?? []).length, 3);
  assert.match(html, /<\/table><\/div><p>Done.<\/p>/);
});
