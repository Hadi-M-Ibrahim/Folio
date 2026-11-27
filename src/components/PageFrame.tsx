import type { ReactNode } from 'react';
import { ArrowDown, ArrowRight, BookOpen, ClipboardList } from 'lucide-react';
import type { ReviewSummary } from '../review/localReviews';
import { ReviewList, type ReviewActions } from './ReviewList';

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

function Home({ reviews, reviewActions }: { reviews: ReviewSummary[]; reviewActions?: ReviewActions }) {
  return (
    <>
      <div className="entry-status page-heading">
        <p><output>Opening review…</output></p>
      </div>
      <section className="opening" aria-labelledby="opening-title">
        <img className="opening-landscape" src="/paper-landscape.webp" alt="" width="1672" height="941" loading="lazy" fetchPriority="high" />
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
          {reviews.length > 0 && <ReviewList reviews={reviews} actions={reviewActions} />}
        </section>
      </div>
    </>
  );
}

export function PageFrame({ children, reviews = [], reviewActions, storageWarning }: {
  children?: ReactNode; reviews?: ReviewSummary[]; reviewActions?: ReviewActions; storageWarning?: string;
}) {
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
      {storageWarning && <p className="local-storage-notice" role="alert">{storageWarning}</p>}
      <main id="main" tabIndex={-1} className={children == null ? 'home-main' : undefined}>
        {children ?? <Home reviews={reviews} reviewActions={reviewActions} />}
      </main>
    </>
  );
}
