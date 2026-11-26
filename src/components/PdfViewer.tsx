import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { openPdf } from '../review/pdf';
import { searchRanges } from '../review/searchText';
import './PdfViewer.css';

type Highlight = { page: number; text: string; term?: boolean };
type ViewerProps = {
  file: File;
  pages?: readonly number[];
  initialPage?: number;
  onPageChange?: (physicalPage: number) => void;
  highlight?: Highlight;
};
const zoomLevels = [0.75, 1, 1.25, 1.5, 2, 3];
const fit = zoomLevels.indexOf(1);

function markText(container: HTMLElement, quote: string, term: boolean) {
  const runs = Array.from(container.children);
  const textOf = (run: Element) => run.tagName === 'BR' ? '\n' : run.textContent || '';
  const text = runs.map(textOf).join('');
  const start = text.indexOf(quote);
  const hits = term ? searchRanges(text, quote) : start < 0 ? [] : [{ start, end: start + quote.length }];
  let offset = 0;
  let hit = 0;
  for (const run of runs) {
    const value = textOf(run);
    const end = offset + value.length;
    let cursor = offset;
    while (hit < hits.length && hits[hit].start < end) {
      const from = Math.max(offset, hits[hit].start), to = Math.min(end, hits[hit].end);
      if (run.tagName !== 'BR' && to > from) {
        if (cursor === offset) run.replaceChildren();
        const mark = document.createElement('mark');
        mark.textContent = value.slice(from - offset, to - offset);
        run.append(value.slice(cursor - offset, from - offset), mark);
        cursor = to;
      }
      if (hits[hit].end > end) break;
      hit++;
    }
    if (cursor > offset) run.append(value.slice(cursor - offset));
    offset = end;
  }
}

function PdfPage({ pdf, number, scale, fileName, highlight }: {
  pdf: PDFDocumentProxy; number: number; scale: number; fileName: string; highlight?: Highlight;
}) {
  const track = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [status, setStatus] = useState('');
  const markedText = highlight?.page === number ? highlight.text : '';
  const term = Boolean(highlight?.term);
  useEffect(() => {
    const element = track.current!;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!width) return;
    const paper = sheet.current!;
    let active = true;
    let render: RenderTask | undefined;
    let layer: TextLayer | undefined;
    let page: PDFPageProxy | undefined;
    const canvas = document.createElement('canvas');
    const textLayer = document.createElement('div');
    textLayer.className = 'pdf-text-layer';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Page ' + number + ' of ' + fileName);
    async function draw() {
      const { TextLayer } = await import('pdfjs-dist');
      if (!active) return;
      setStatus('Rendering page ' + number + '…');
      page = await pdf.getPage(number);
      if (!active) return;
      const unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width * scale / unscaled.width });
      const density = Math.min(window.devicePixelRatio || 1, 4096 / Math.max(viewport.width, viewport.height),
        Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      canvas.width = Math.max(1, Math.floor(viewport.width * density));
      canvas.height = Math.max(1, Math.floor(viewport.height * density));
      paper.style.width = viewport.width + 'px';
      paper.style.height = viewport.height + 'px';
      paper.style.setProperty('--total-scale-factor', String(viewport.scale * page.userUnit));
      render = page.render({ canvas, viewport, transform: [density, 0, 0, density, 0, 0] });
      await render.promise;
      if (!active) return;
      paper.replaceChildren(canvas, textLayer);
      setStatus('');
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport });
      await layer.render();
      if (active && markedText) markText(textLayer, markedText, term);
    }
    void draw().catch(() => {
      if (!active) return;
      setStatus(canvas.isConnected ? 'Page text is unavailable.' : 'Could not display this PDF page. Download the original to view it.');
    });
    return () => {
      active = false;
      render?.cancel();
      layer?.cancel();
      page?.cleanup();
      paper.replaceChildren();
      canvas.width = canvas.height = 0;
    };
  }, [pdf, number, scale, fileName, width, markedText, term]);

  // Explicit focus enables keyboard scrolling in browsers that skip scrollable regions.
  // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
  return <section className="pdf-scroll" aria-label={'Page ' + number + ' preview'} tabIndex={0}>
    {status && <output className="pdf-status">{status}</output>}
    <div className="pdf-track" ref={track}><div className="pdf-sheet" ref={sheet} /></div>
  </section>;
}

function LoadedPdf({ pdf, file, pages, initialPage, onPageChange, highlight }: ViewerProps & { pdf: PDFDocumentProxy }) {
  const numbers = pages ?? Array.from({ length: pdf.numPages }, (_, i) => i + 1);
  const [current, setCurrent] = useState(initialPage ?? numbers[0]);
  const [zoom, setZoom] = useState(fit);
  const number = numbers.includes(current) ? current : numbers[0];
  const index = numbers.indexOf(number);
  function go(target: number) { setCurrent(target); onPageChange?.(target); }
  if (!numbers.length) return <p className="pdf-status">Choose pages to preview.</p>;
  return <>
    <div className="pdf-toolbar">
      <div className="pdf-controls">
        <button type="button" aria-label="Previous PDF page" disabled={index === 0} onClick={() => go(numbers[index - 1])}>
          <ChevronLeft size={17} /></button>
        <select aria-label="PDF page" value={number} onChange={(event) => go(Number(event.target.value))}>
          {numbers.map((n) => <option key={n} value={n}>Page {n}</option>)}
        </select>
        <span className="pdf-total">of {pdf.numPages}</span>
        <button type="button" aria-label="Next PDF page" disabled={index >= numbers.length - 1} onClick={() => go(numbers[index + 1])}>
          <ChevronRight size={17} /></button>
      </div>
      <div className="pdf-controls">
        <button type="button" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom(zoom - 1)}><Minus size={15} /></button>
        <span className="pdf-zoom">{zoomLevels[zoom] * 100}%</span>
        <button type="button" aria-label="Zoom in" disabled={zoom === zoomLevels.length - 1} onClick={() => setZoom(zoom + 1)}><Plus size={15} /></button>
        <button type="button" aria-label="Fit to width" title="Fit to width" onClick={() => setZoom(fit)}><Maximize2 size={15} /></button>
      </div>
    </div>
    <PdfPage key={number} pdf={pdf} number={number} fileName={file.name} highlight={highlight} scale={zoomLevels[zoom]} />
  </>;
}

export function PdfViewer(props: ViewerProps) {
  const { file } = props;
  const [loaded, setLoaded] = useState<{ file: File; url: string; pdf?: PDFDocumentProxy; error?: string }>();
  useEffect(() => {
    const url = URL.createObjectURL(file);
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    async function load() {
      task = await openPdf(file);
      if (!active) { await task.destroy(); return; }
      const pdf = await task.promise;
      if (active) setLoaded({ file, url, pdf });
    }
    void load().catch(() => {
      if (active) setLoaded({ file, url, error: 'Could not display this PDF. Download the original to view it.' });
    });
    return () => {
      active = false;
      URL.revokeObjectURL(url);
      void task?.destroy().catch(() => {});
    };
  }, [file]);
  const result = loaded?.file === file ? loaded : undefined;
  return <section className="pdf-viewer" aria-label="PDF preview">
    {result?.pdf ? <LoadedPdf key={props.initialPage} {...props} pdf={result.pdf} /> :
      <output className="pdf-status">{result?.error ?? 'Opening PDF…'}</output>}
    {result && <a className="pdf-download" href={result.url} download={file.name}>Download original PDF</a>}
  </section>;
}
