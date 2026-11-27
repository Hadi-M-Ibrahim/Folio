import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import {
  forgetRecentPolicies, readPreviousPolicyReview, readRecentPolicies, subscribeRecentPolicies, type RecentPolicySet,
} from '../review/recentPolicies';

export type LastPolicyChoice = { kind: 'upload'; set: RecentPolicySet } | { kind: 'review'; key: string; title: string; files: string[] };

async function lastChoice(): Promise<LastPolicyChoice | undefined> {
  const set = await readRecentPolicies();
  if (set) return { kind: 'upload', set };
  if (set === null) return;
  // Reviews saved before uploads had a separate history can still supply policies.
  const review = await readPreviousPolicyReview();
  if (review) return { kind: 'review', ...review };
}

export function LastPolicies({ onUse, onError }: {
  onUse: (choice: LastPolicyChoice) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [choice, setChoice] = useState<LastPolicyChoice>();
  const [forgetting, setForgetting] = useState(false);
  useEffect(() => {
    let version = 0;
    function refresh() {
      const read = ++version;
      void lastChoice().then(value => { if (read === version) setChoice(value); },
        () => { if (read === version) setChoice(undefined); });
    }
    const unsubscribe = subscribeRecentPolicies(refresh);
    refresh();
    return () => { version++; unsubscribe(); };
  }, []);

  if (!choice) return null;
  const names = choice.kind === 'upload' ? choice.set.files.map(file => file.title) : choice.files;
  const files = names.slice(0, 2).join(' · ') + (names.length > 2 ? ' · +' + (names.length - 2) + ' more' : '');
  const description = choice.kind === 'review' ? choice.title + ' — ' + files : files;

  async function forget(set: RecentPolicySet) {
    setForgetting(true);
    try {
      await forgetRecentPolicies(set.revision);
    } catch {
      onError('The saved files couldn’t be forgotten. Try again.');
    } finally {
      setForgetting(false);
    }
  }

  return (
    <div className="last-policies">
      <button className="last-policies-use" type="button" aria-describedby="last-policy-files"
        disabled={forgetting} onClick={() => void onUse(choice)}>
        <History size={17} aria-hidden="true" />{choice.kind === 'upload' ? 'Use last policies' : 'Use policies from a saved review'}
      </button>
      {choice.kind === 'upload' && <button type="button" className="last-policies-forget" aria-label="Forget saved policies"
        disabled={forgetting} onClick={() => void forget(choice.set)}>Forget</button>}
      <p id="last-policy-files" title={names.join(', ') || description}>{description}</p>
    </div>
  );
}
