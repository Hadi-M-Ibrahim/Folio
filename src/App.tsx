import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useReviewLibrary } from './review/reviewLibrary';
import { useReviewState } from './review/reviewJob';
import { PageFrame, workflows } from './components/PageFrame';
import { modeLabels } from './review/model';

function onHashChange(notify: () => void) {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
}

function currentPath() {
  return window.location.hash.slice(1);
}

function OpeningReview({ failed }: { failed: boolean }) {
  return (
    <div className="page-heading">
      <p><output>{failed ? 'The review tools couldn’t load.' : 'Opening review…'}</output></p>
      {failed && <button className="secondary" onClick={() => window.location.reload()}>Reload review</button>}
    </div>
  );
}

export default function App() {
  const path = useSyncExternalStore(onHashChange, currentPath, () => '');
  const reviewKey = path.startsWith('/review/') ? path.slice('/review/'.length) : undefined;
  const library = useReviewLibrary(reviewKey);
  const [screens, setScreens] = useState<typeof import('./components/reviewScreens')>();
  const [loadFailed, setLoadFailed] = useState(false);
  const setupMode = workflows.find(({ mode }) => ['', '/source', '/policies'].some(suffix => path === '/new/' + mode + suffix))?.mode;
  const lastView = useRef({ path, screens });
  const review = library.job(reviewKey);
  const listed = library.items.find(item => item.key === reviewKey);
  const reviewState = useReviewState(review);
  const missing = Boolean(reviewKey && !review && library.ready && !listed && !library.warning);
  const opening = Boolean(reviewKey && !review && !missing);
  const home = !setupMode && !reviewKey;

  useLayoutEffect(() => {
    if (path === currentPath()) document.documentElement.classList.remove('opening-review');
  }, [path]);

  useEffect(() => {
    if (home || missing || screens || loadFailed) return;
    let active = true;
    import('./components/reviewScreens').then(
      (module) => { if (active) setScreens(module); },
      () => { if (active) setLoadFailed(true); },
    );
    return () => { active = false; };
  }, [home, missing, screens, loadFailed]);

  useEffect(() => {
    const title = listed?.title ?? (missing ? 'Review not found' : setupMode ? modeLabels[setupMode] : 'Policy review');
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
  }, [home, missing, path, listed?.title, reviewState.kind, setupMode, screens]);

  return (
    <PageFrame reviews={library.items} reviewActions={library} storageWarning={library.warning}>
      {home ? undefined : missing ? (
        <div className="page-heading">
          <h1 tabIndex={-1}>Review not found</h1>
          <p>This review isn’t saved in this browser.</p>
          <p><a className="text-link" href="#review-options">View all reviews</a></p>
        </div>
      ) : !screens || opening ? (
        <OpeningReview failed={loadFailed || Boolean(opening && library.warning)} />
      ) : setupMode ? (
        <screens.Setup key={setupMode} initialMode={setupMode} sourceStep={path.endsWith('/source')} onClose={() => { window.location.hash = 'review-options'; }} onSubmit={library.submit} />
      ) : reviewState.kind === 'complete' ? (
        <screens.ReviewWorkspace key={reviewState.review.key} review={reviewState.review} findingStates={library.findings(reviewKey)} onUpdateFinding={library.updateFinding} />
      ) : review && (
        <screens.PendingReview job={review} state={reviewState} onStart={() => void library.resume(review)} />
      )}
    </PageFrame>
  );
}
