import { useEffect, useState, useSyncExternalStore } from 'react';
import { ArrowRight, BookOpen, ClipboardList } from 'lucide-react';
import { ReviewWorkspace } from './components/ReviewWorkspace';
import { Setup } from './components/Setup';
import { modeLabels, type Decision, type Mode, type Review } from './review/model';

function onHashChange(notify: () => void) {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
}

function currentPath() {
  return window.location.hash.slice(1);
}

const workflows = [
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
    <section className="review-home" aria-labelledby="home-title">
      <h1 id="home-title" tabIndex={-1}>Start a review</h1>
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
  );
}

export default function App() {
  const path = useSyncExternalStore(onHashChange, currentPath);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [decisions, setDecisions] = useState(() => new Map<string, Decision>());
  const setupMode: Mode | undefined = workflows.find(({ mode }) =>
    path === '/new/' + mode || path === '/new/' + mode + '/policies',
  )?.mode;
  const review = reviews.find((item) => path === '/review/' + item.key);

  useEffect(() => {
    const title = review?.title ?? (setupMode ? modeLabels[setupMode] : 'Policy review');
    document.title = title + ' · Folio';
    window.scrollTo(0, 0);
    const heading = document.querySelector<HTMLElement>('main h1');
    heading?.focus({ preventScroll: true });
  }, [path, review, setupMode]);

  function openReview(newReview: Review) {
    setReviews((current) => [newReview, ...current]);
    window.location.hash = '/review/' + newReview.key;
  }

  function saveDecision(key: string, decision?: Decision) {
    setDecisions((current) => {
      const next = new Map(current);
      if (decision) next.set(key, decision);
      else next.delete(key);
      return next;
    });
  }

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
      <main id="main" tabIndex={-1}>
        {setupMode ? (
          <Setup key={setupMode} initialMode={setupMode} policyStep={path.endsWith('/policies')} onClose={() => { window.location.hash = '/'; }} onDone={openReview} />
        ) : review ? (
          <ReviewWorkspace key={review.key} review={review} decisions={decisions} onDecisionChange={saveDecision} />
        ) : <Home reviews={reviews} />}
      </main>
    </>
  );
}
