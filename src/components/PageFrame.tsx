import type { ReactNode } from 'react';
import { ArrowDown, ArrowRight, BookOpen, ClipboardList } from 'lucide-react';
import { modeLabels, type Review } from '../review/model';

export const workflows = [
  {
    mode: 'questionnaire',
    title: 'Answer a questionnaire',
    description: 'Find existing policy evidence for each state inquiry and prepare a cited response.',
    Icon: ClipboardList,
  },
  {
    mode: 'guide',
    title: 'Review a new policy guide',
    description: 'Identify the obligations and decide which policies to write or update.',
    Icon: BookOpen,
  },
] as const;

function Home({ reviews }: { reviews: Review[] }) {
  return (
    <>
      <div className="entry-status page-heading">
        <p><output>Opening review…</output></p>
      </div>
      <section className="opening" aria-labelledby="opening-title">
        <img className="opening-landscape" src="/paper-landscape.webp" alt="" width="1672" height="941" fetchPriority="high" />
        <div className="opening-copy">
          <h1 id="opening-title" tabIndex={-1}>Policy review</h1>
          <p>Answer state inquiries and review new guidance against your existing policies.</p>
          <a className="opening-link" href="#review-options">
            Start a review <ArrowDown size={16} aria-hidden="true" />
          </a>
        </div>
      </section>
      <div className="review-surface">
        <section className="review-home" aria-labelledby="review-options">
          <h2 id="review-options" tabIndex={-1}>Start a review</h2>
          <div className="workflow-list">
            {workflows.map(({ mode, title, description, Icon }) => (
              <a className="workflow-option" key={mode} href={'#/new/' + mode}>
                <span aria-hidden="true" className={'workflow-icon ' + mode}><Icon size={25} /></span>
                <span className="workflow-copy">
                  <span className="workflow-title">{title}</span>
                  <span className="workflow-description">{description}</span>
                </span>
                <ArrowRight aria-hidden="true" size={24} />
              </a>
            ))}
          </div>
          {reviews.length > 0 && (
            <section className="session-reviews" aria-labelledby="session-title">
              <h2 id="session-title">Reviews in this tab</h2>
              {reviews.map((review) => (
                <a className="session-review" key={review.key} href={'#/review/' + review.key}>
                  <span>{review.title}</span><small>{modeLabels[review.input.mode]}</small>
                  <ArrowRight aria-hidden="true" size={17} />
                </a>
              ))}
            </section>
          )}
        </section>
      </div>
    </>
  );
}

export function PageFrame({ children, reviews = [] }: { children?: ReactNode; reviews?: Review[] }) {
  return (
    <>
      <a href="#main" className="skip-link" onClick={(e) => {
        e.preventDefault();
        document.querySelector<HTMLElement>('main')?.focus();
      }}>Skip to content</a>
      <header className="app-header">
        <div className="header-inner">
          <a href="#/" className="brand" aria-label="Folio home">
            <img className="brand-icon" src="/folio.svg" width="32" height="32" alt="" />
            Folio
          </a>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={children == null ? 'home-main' : undefined}>
        {children ?? <Home reviews={reviews} />}
      </main>
    </>
  );
}
