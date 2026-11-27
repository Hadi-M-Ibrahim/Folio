import { useState } from 'react';
import { FileSearch } from 'lucide-react';
import type { Evidence, Finding, Policy } from '../review/model';
import { EvidenceCard, type EvidenceControls } from './EvidenceCard';
import { SearchTrail } from './SearchTrail';

function EvidenceGroup({ passages, kind, ...controls }: EvidenceControls & {
  passages: Evidence[];
  kind: 'support' | 'counter';
}) {
  const [first, ...more] = passages;
  if (!first) return null;
  return (
    <>
      <EvidenceCard evidence={first} kind={kind} {...controls} />
      {more.length > 0 && <details className="additional-evidence">
        <summary>{more.length} more {kind === 'support' ? 'supporting' : 'conflicting'} {more.length === 1 ? 'passage' : 'passages'}</summary>
        {more.map((passage, i) => <EvidenceCard key={i} evidence={passage} kind={kind} {...controls} />)}
      </details>}
    </>
  );
}

export function PolicyEvidence({ finding, documents, isGuide, ...controls }: EvidenceControls & {
  finding: Finding;
  documents: Policy[];
  isGuide: boolean;
}) {
  const [showSearch, setShowSearch] = useState(false);
  const evidenceCount = finding.supporting.length + finding.counter.length;
  const leadMatch = evidenceCount === 0 ? finding.candidates[0] : undefined;

  return (
    <>
      <div className="assessment">
        <h3>{finding.analysisEngine === 'anthropic' ? (isGuide ? 'Policy coverage' : 'Suggested answer') : 'Keyword search'}</h3>
        <p>{finding.answer}</p>
      </div>
      <EvidenceGroup passages={finding.supporting} kind="support" {...controls} />
      <EvidenceGroup passages={finding.counter} kind="counter" {...controls} />
      {leadMatch && !showSearch && <EvidenceCard evidence={leadMatch} kind="candidate" {...controls} />}
      {!evidenceCount && !leadMatch && (
        <div className="empty-inline">
          <FileSearch />
          <strong>No policy passages retrieved</strong>
        </div>
      )}
      <SearchTrail finding={finding} documents={documents} open={showSearch} onToggle={() => setShowSearch(!showSearch)} {...controls} />
    </>
  );
}
