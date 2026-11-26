import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PageFrame, workflows } from './components/PageFrame';
import { modeLabels, type Decision, type Review } from './review/model';

function onHashChange(notify: () => void) {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
}

function currentPath() {
  return window.location.hash.slice(1);
}

export default function App() {
  const path = useSyncExternalStore(onHashChange, currentPath, () => '');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [decisions, setDecisions] = useState(() => new Map<string, Decision>());
  const [screens, setScreens] = useState<typeof import('./components/reviewScreens')>();
  const [loadFailed, setLoadFailed] = useState(false);
  const setupMode = workflows.find(({ mode }) => path === '/new/' + mode || path === '/new/' + mode + '/policies')?.mode;
  const lastView = useRef({ path, screens });
  const review = reviews.find((item) => path === '/review/' + item.key);
  const home = !setupMode && !review;

  useLayoutEffect(() => {
    if (path === currentPath()) document.documentElement.classList.remove('opening-review');
  }, [path]);

  useEffect(() => {
    if (home || screens || loadFailed) return;
    let active = true;
    import('./components/reviewScreens').then(
      (module) => { if (active) setScreens(module); },
      () => { if (active) setLoadFailed(true); },
    );
    return () => { active = false; };
  }, [home, screens, loadFailed]);

  useEffect(() => {
    const title = review?.title ?? (setupMode ? modeLabels[setupMode] : 'Policy review');
    document.title = title + ' · Folio';
    // The browser may already have followed an anchor or restored scroll before hydration.
    const previous = lastView.current;
    lastView.current = { path, screens };
    if (home && path === previous.path && screens === previous.screens) return;
    if (path === 'review-options') {
      const options = document.getElementById('review-options');
      options?.focus({ preventScroll: true });
      options?.scrollIntoView({ block: 'start' });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    const heading = document.querySelector<HTMLElement>('main h1');
    heading?.focus({ preventScroll: true });
  }, [home, path, review, setupMode, screens]);

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
    <PageFrame reviews={reviews}>
      {home ? undefined : !screens ? (
        <div className="page-heading">
          <p><output>{loadFailed ? 'The review tools couldn’t load.' : 'Opening review…'}</output></p>
          {loadFailed && <button className="secondary" onClick={() => window.location.reload()}>Reload review</button>}
        </div>
      ) : setupMode ? (
        <screens.Setup key={setupMode} initialMode={setupMode} policyStep={path.endsWith('/policies')} onClose={() => { window.location.hash = 'review-options'; }} onDone={openReview} />
      ) : review && (
        <screens.ReviewWorkspace key={review.key} review={review} decisions={decisions} onDecisionChange={saveDecision} />
      )}
    </PageFrame>
  );
}
