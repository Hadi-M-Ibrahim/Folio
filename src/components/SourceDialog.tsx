import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, X } from 'lucide-react';
import type { SourceLocation } from '../review/guideSource';
import { highlightRanges } from '../review/searchText';
import { PdfViewer } from './PdfViewer';

function highlightPage(text: string, page: number, location: SourceLocation) {
  const { quote, marks, term } = location;
  if (!quote || (!marks && page !== location.page)) return text;
  const hits = marks ? marks.filter(mark => mark.page === page) : highlightRanges(text, quote, term);
  if (!hits.length) return text;
  return (
    <>
      {hits.map(({ start, end }, index) => (
        <Fragment key={start}>
          {text.slice(hits[index - 1]?.end ?? 0, start)}
          <mark>{text.slice(start, end)}</mark>
        </Fragment>
      ))}
      {text.slice(hits.at(-1)?.end ?? 0)}
    </>
  );
}

export function SourceDialog({ location, onClose }: { location: SourceLocation; onClose: () => void }) {
  const { doc } = location;
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      previousFocus?.focus();
    };
  }, []);
  return (
    <dialog ref={ref} className="modal" aria-labelledby="dialog-title" onCancel={event => {
      event.preventDefault();
      onClose();
    }}>
      <div className="modal-head">
        <div>
          <h2 id="dialog-title">{doc.title}</h2>
          <p>Source document</p>
        </div>
        <button className="icon-button close" aria-label="Close dialog" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      {doc.pdfFile ? <PdfSource location={location} file={doc.pdfFile} /> : <TextSource location={location} />}
    </dialog>
  );
}

function PdfSource({ location, file }: { location: SourceLocation; file: File }) {
  const [page, setPage] = useState(location.page);
  const marks = location.marks?.filter(mark => mark.page === page);
  const text = location.doc.pages.find(item => item.number === page)?.text ?? '';
  const excerpt = marks?.length ? marks.map(mark => text.slice(mark.start, mark.end)).join(' … ')
    : page === location.page ? location.quote : '';
  const citedPages = [...new Set(location.marks?.map(mark => mark.page))];
  const citation = citedPages.length > 1 ? 'pp. ' + citedPages.join(', ') : 'p. ' + location.page;
  return (
    <>
      {location.quote && <aside className="pdf-citation" aria-label={location.term ? 'Search term' : 'Cited passage'}>
        <strong>{location.term ? 'Search term' : 'Cited passage'} · {citation}</strong>
        <blockquote>{location.quote}</blockquote>
      </aside>}
      <PdfViewer file={file} pages={location.doc.pages.map(item => item.number)} initialPage={location.page}
        onPageChange={setPage} highlight={excerpt ? { page, text: excerpt, term: location.term } : undefined} />
    </>
  );
}

function TextSource({ location }: { location: SourceLocation }) {
  const pages = location.doc.pages;
  const [index, setIndex] = useState(() => pages.findIndex((page) => page.number === location.page));
  const page = pages[index];
  const paperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    const mark = paper.querySelector('mark');
    if (mark) mark.scrollIntoView({ block: 'nearest' });
    else paper.scrollTop = 0;
  }, [location, page]);
  return (
    <>
      <div className="source-toolbar">
        <span>
          <FileText size={15} />
          {location.unpaginated ? 'Submitted text' : 'Page ' + (page?.number ?? location.page)}
        </span>
        {pages.length > 1 && <div>
          <button
            className="icon-button"
            disabled={index <= 0}
            aria-label="Previous page"
            onClick={() => setIndex(index - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="icon-button"
            disabled={!page || index >= pages.length - 1}
            aria-label="Next page"
            onClick={() => setIndex(index + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>}
      </div>
      <div className="source-paper" ref={paperRef}>
        {page ? highlightPage(page.text, page.number, location) : 'The cited page is unavailable in this review.'}
      </div>
    </>
  );
}
