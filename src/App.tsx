import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useReviewState, type ReviewJob } from './review/reviewJob';
import { PageFrame, workflows } from './components/PageFrame';
import { modeLabels, type FindingState } from './review/model';

function onHashChange(notify: () => void) {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
}

function currentPath() {
  return window.location.hash.slice(1);
}

export default function App() {
  const path = useSyncExternalStore(onHashChange, currentPath, () => '');
  const [reviews, setReviews] = useState<ReviewJob[]>([]);
  const [findingStates, setFindingStates] = useState(() => new Map<string, FindingState>());
  const [screens, setScreens] = useState<typeof import('./components/reviewScreens')>();
  const [loadFailed, setLoadFailed] = useState(false);
  const setupMode = workflows.find(({ mode }) => path === '/new/' + mode || path === '/new/' + mode + '/policies')?.mode;
  const lastView = useRef({ path, screens });
  const review = reviews.find((item) => path === '/review/' + item.key);
  const reviewState = useReviewState(review);
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
  }, [home, path, review, reviewState.kind, setupMode, screens]);

  function trackReview(job: ReviewJob) {
    if (job.submitted) return;
    job.track(() => setReviews(current => current.filter(item => item !== job)));
    setReviews(current => [job, ...current]);
  }

  function updateFinding(key: string, changes: FindingState) {
    setFindingStates((current) => {
      const previous = current.get(key);
      const state = { ...previous, ...changes };
      if (state.decision?.value !== previous?.decision?.value) {
        state.resolved = !!state.decision?.value;
      }
      const next = new Map(current);
      if (state.decision || state.resolved) next.set(key, state);
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
        <screens.Setup key={setupMode} initialMode={setupMode} policyStep={path.endsWith('/policies')} onClose={() => { window.location.hash = 'review-options'; }} onSubmit={trackReview} />
      ) : reviewState.kind === 'complete' ? (
        <screens.ReviewWorkspace key={reviewState.review.key} review={reviewState.review} findingStates={findingStates} onUpdateFinding={updateFinding} />
      ) : review && (
        <screens.PendingReview job={review} state={reviewState} />
      )}
    </PageFrame>
  );
}
