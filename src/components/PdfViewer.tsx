import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { openPdf } from '../review/pdf';
import { highlightRanges } from '../review/searchText';
import './PdfViewer.css';

type Highlight = { page: number; text: string; term?: boolean };
type ViewerProps = {
  file: File;
  pages: readonly number[];
  initialPage?: number;
  onPageChange?: (physicalPage: number) => void;
  highlight?: Highlight;
};
const zoomLevels = [0.75, 1, 1.25, 1.5, 2, 3];
const fit = zoomLevels.indexOf(1);

function markText(container: HTMLElement, quote: string, term: boolean) {
  const runs = Array.from(container.children);
  const textOf = (run: Element) => run.tagName === 'BR' ? '\n' : run.textContent || '';
  const hits = highlightRanges(runs.map(textOf).join(''), quote, term);
  if (!hits.length) return;
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

function revealMark(container: HTMLElement, scroll: HTMLElement) {
  const mark = container.querySelector('mark');
  if (!mark) return;
  const markBox = mark.getBoundingClientRect(), scrollBox = scroll.getBoundingClientRect();
  if (markBox.top < scrollBox.top || markBox.bottom > scrollBox.bottom) {
    scroll.scrollTop += markBox.top - scrollBox.top - scroll.clientHeight / 3;
  }
}

function PdfPage({ pdf, number, scale, fileName, highlight }: {
  pdf: PDFDocumentProxy; number: number; scale: number; fileName: string; highlight?: Highlight;
}) {
  const track = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const visible = useRef<{ canvas: HTMLCanvasElement; number: number; quote: string; term: boolean } | null>(null);
  const [width, setWidth] = useState(0);
  const [displayed, setDisplayed] = useState<number>();
  const [error, setError] = useState('');
  const markedText = highlight?.page === number ? highlight.text : '';
  const term = Boolean(highlight?.term);
  useLayoutEffect(() => {
    const element = track.current!;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => {
      observer.disconnect();
      const previous = visible.current;
      if (previous) previous.canvas.width = previous.canvas.height = 0;
      visible.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    if (!width) return;
    const paper = sheet.current!;
    const scroll = scroller.current!;
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
      setError('');
      page = await pdf.getPage(number);
      if (!active) return;
      const unscaled = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width * scale / unscaled.width });
      const density = Math.min(window.devicePixelRatio || 1, 4096 / Math.max(viewport.width, viewport.height),
        Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      canvas.width = Math.max(1, Math.floor(viewport.width * density));
      canvas.height = Math.max(1, Math.floor(viewport.height * density));
      render = page.render({ canvas, viewport, transform: [density, 0, 0, density, 0, 0] });
      await render.promise;
      render = undefined;
      if (!active) return;
      let textError = '';
      try {
        layer = new TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport });
        await layer.render();
        if (active && markedText) markText(textLayer, markedText, term);
      } catch {
        textError = 'Text is unavailable on page ' + number + '.';
      }
      if (!active) return;
      const previous = visible.current;
      const changedPage = previous?.number !== number;
      // Commit the finished pixels and their dimensions together. The visible
      // canvas belongs to the viewport until a newer render succeeds.
      paper.style.width = viewport.width + 'px';
      paper.style.height = viewport.height + 'px';
      paper.style.setProperty('--total-scale-factor', String(viewport.scale * page.userUnit));
      paper.replaceChildren(canvas, textLayer);
      visible.current = { canvas, number, quote: markedText, term };
      if (previous) previous.canvas.width = previous.canvas.height = 0;
      if (changedPage) scroll.scrollTo(0, 0);
      if (markedText && (changedPage || previous?.quote !== markedText || previous?.term !== term)) {
        revealMark(textLayer, scroll);
      }
      setDisplayed(number);
      setError(textError);
    }
    void draw().catch(() => {
      if (!active) return;
      const showing = visible.current ? ' Showing page ' + visible.current.number + '.' : '';
      setError('Could not display page ' + number + '.' + showing + ' Download the original to view it.');
    }).finally(() => {
      render = undefined;
      layer = undefined;
      page?.cleanup();
      if (visible.current?.canvas !== canvas) canvas.width = canvas.height = 0;
    });
    return () => {
      active = false;
      render?.cancel();
      layer?.cancel();
    };
  }, [pdf, number, scale, fileName, width, markedText, term]);

  const busy = displayed !== number && !error;
  const status = error || (busy ? 'Rendering page ' + number + '…' : 'Page ' + number + ' displayed.');
  return <>
    {/* Explicit focus enables keyboard scrolling in browsers that skip scrollable regions. */}
    {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
    <section className="pdf-scroll" ref={scroller} tabIndex={0}
      aria-label={'Page ' + (displayed ?? number) + ' preview'} aria-busy={busy}>
      <div className="pdf-track" ref={track}><div className="pdf-sheet" ref={sheet} /></div>
    </section>
    <output className="pdf-status" data-ready={!busy && !error} data-updating={busy && !!displayed}>{status}</output>
  </>;
}

function PdfPreview({ pdf, file, pages, initialPage, onPageChange, highlight, error }: ViewerProps & {
  pdf?: PDFDocumentProxy; error?: string;
}) {
  const [current, setCurrent] = useState(initialPage ?? pages[0]);
  const [zoom, setZoom] = useState(fit);
  const index = Math.max(0, pages.indexOf(current));
  const number = pages[index];
  function go(target: number) { setCurrent(target); onPageChange?.(target); }
  const enabled = Boolean(pdf && pages.length);
  return <>
    <div className="pdf-toolbar">
      <div className="pdf-controls">
        <button type="button" aria-label="Previous PDF page" disabled={!enabled || index === 0} onClick={() => go(pages[index - 1])}>
          <ChevronLeft size={17} /></button>
        <select aria-label="PDF page" disabled={!enabled} value={number}
          onChange={(event) => go(Number(event.target.value))}>
          {pages.map((n) => <option key={n} value={n}>Page {n}</option>)}
        </select>
        <span className="pdf-total">of {pdf?.numPages ?? '…'}</span>
        <button type="button" aria-label="Next PDF page" disabled={!enabled || index >= pages.length - 1} onClick={() => go(pages[index + 1])}>
          <ChevronRight size={17} /></button>
      </div>
      <div className="pdf-controls">
        <button type="button" aria-label="Zoom out" disabled={!enabled || zoom === 0} onClick={() => setZoom(zoom - 1)}><Minus size={15} /></button>
        <span className="pdf-zoom">{zoomLevels[zoom] * 100}%</span>
        <button type="button" aria-label="Zoom in" disabled={!enabled || zoom === zoomLevels.length - 1} onClick={() => setZoom(zoom + 1)}><Plus size={15} /></button>
        <button type="button" aria-label="Fit to width" title="Fit to width" disabled={!enabled} onClick={() => setZoom(fit)}><Maximize2 size={15} /></button>
      </div>
    </div>
    <div className="pdf-frame">
      {pdf && pages.length > 0 ? <PdfPage pdf={pdf} number={number} fileName={file.name} highlight={highlight} scale={zoomLevels[zoom]} /> :
        <output className="pdf-status">{error ?? (pdf ? 'Choose pages to preview.' : 'Opening PDF…')}</output>}
    </div>
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
    <PdfPreview key={(result?.url ?? '') + '/' + props.initialPage} {...props} pdf={result?.pdf} error={result?.error} />
    <div className="pdf-download-row">
      {result && <a className="pdf-download" href={result.url} download={file.name}>Download original PDF</a>}
    </div>
  </section>;
}
