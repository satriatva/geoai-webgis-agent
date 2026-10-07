/**
 * Clickable results: every feature the agent draws gets an id, and the places in an answer
 * (the result list and the names in the reply text) link to it.
 */
import { escapeHtml, formatDistance } from './format.js';

const MIN_LINK_LENGTH = 4;     // shorter names match too much ordinary text
const OPEN_LIST_LIMIT = 12;    // longer result lists start collapsed

let batchSeq = 0;

/**
 * Give every feature in an answer's layers an id ("r<batch>-<layer>-<feature>") and return
 * the named points as list items: geocoded places first, then results nearest first.
 */
export function registerLayers(layers) {
  const batch = `r${++batchSeq}`;
  const items = [];
  const seen = new Set();
  layers.forEach((layer, i) => {
    layer.geojson.features.forEach((f, j) => {
      const p = (f.properties ??= {});
      p.fid = `${batch}-${i}-${j}`;
      if (f.geometry?.type !== 'Point' || !p.title || !['poi', 'place'].includes(p.kind)) return;
      const key = `${p.title}|${f.geometry.coordinates.join(',')}`;
      if (seen.has(key)) return; // the same place returned by two tools
      seen.add(key);
      items.push({ fid: p.fid, title: p.title, kind: p.kind, distance: p.distance_m });
    });
  });
  items.sort((a, b) => (a.kind === b.kind ? (a.distance ?? 0) - (b.distance ?? 0) : a.kind === 'place' ? -1 : 1));
  return { batch, items };
}

/** Batch id of a feature id, used to find the answer the feature belongs to. */
export const batchOf = (fid) => fid.split('-')[0];

/** Short display name: Nominatim names are long ("Malioboro, Sosromenduran, ..."). */
const shortName = (title) => title.split(',')[0].trim();

/** List of the places drawn on the map, shown under the answer. */
export function renderResults(items) {
  const box = document.createElement('details');
  box.className = 'results';
  box.open = items.length <= OPEN_LIST_LIMIT;
  const count = `${items.length} ${items.length === 1 ? 'place' : 'places'} on the map`;
  box.innerHTML = `
    <summary class="results-head"><span>${count}</span><span>Select to zoom</span></summary>
    <ol>${items
      .map((it) => `<li><button type="button" class="result-item" data-fid="${it.fid}" title="${escapeHtml(it.title)}">
          <span class="dot ${it.kind}"></span>
          <span class="name">${escapeHtml(shortName(it.title))}</span>
          <span class="dist">${formatDistance(it.distance)}</span></button></li>`)
      .join('')}</ol>`;
  return box;
}

/** Turn place names the model wrote in its answer into links to the matching map feature. */
export function linkifyPlaces(container, items) {
  const targets = items
    .flatMap((it) => [...new Set([it.title, shortName(it.title)])].map((text) => ({ text, fid: it.fid })))
    .filter((t) => t.text.length >= MIN_LINK_LENGTH)
    .sort((a, b) => b.text.length - a.text.length); // longest first, so full names win

  const linked = new Set();
  for (const target of targets) {
    if (linked.has(target.fid)) continue;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('button, code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(target.text);
      if (at === -1) continue;
      const match = node.splitText(at);
      match.splitText(target.text.length);
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'place-link';
      link.dataset.fid = target.fid;
      link.title = 'Show on the map';
      link.textContent = target.text;
      match.replaceWith(link);
      linked.add(target.fid);
      break;
    }
  }
}
