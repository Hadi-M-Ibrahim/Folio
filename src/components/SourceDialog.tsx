import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import type { SourceLocation } from '../review/guideSource';
import { searchRanges } from '../review/searchText';
import { Modal } from './Modal';

function highlightPage(text: string, page: number, location: SourceLocation) {
  const { quote, marks, term } = location;
  if (!quote) return text;
  let hits;
  if (marks) {
    hits = marks.filter((mark) => mark.page === page);
  } else if (page !== location.page) {
    return text;
  } else if (term) {
    hits = searchRanges(text, quote);
  } else {
    const start = text.indexOf(quote);
    if (start < 0) return text;
    hits = [{ start, end: start + quote.length }];
  }
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
  const [pageNumber, setPageNumber] = useState(location.page);
  const paperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    const mark = paper.querySelector('mark');
    if (mark) mark.scrollIntoView({ block: 'nearest' });
    else paper.scrollTop = 0;
  }, [location, pageNumber]);
  const index = location.doc.pages.findIndex((p) => p.number === pageNumber);
  const page = location.doc.pages[index];
  return (
    <Modal title={location.doc.title} subtitle="Source document" onClose={onClose} wide>
      <div className="source-toolbar">
        <span>
          <FileText size={15} />
          {location.unpaginated ? 'Submitted text' : 'Page ' + pageNumber}
        </span>
        {location.doc.pages.length > 1 && <div>
          <button
            className="icon-button"
            disabled={index <= 0}
            aria-label="Previous page"
            onClick={() => setPageNumber(location.doc.pages[index - 1].number)}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="icon-button"
            disabled={index === -1 || index >= location.doc.pages.length - 1}
            aria-label="Next page"
            onClick={() => setPageNumber(location.doc.pages[index + 1].number)}
          >
            <ChevronRight size={16} />
          </button>
        </div>}
      </div>
      <div className="source-paper" ref={paperRef}>
        {page ? highlightPage(page.text, page.number, location) : 'The cited page is unavailable in this review.'}
      </div>
    </Modal>
  );
}
