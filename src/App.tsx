import { useRef, useState, type CSSProperties } from 'react';
import { BookOpen, BookOpenText, Check, Download, ChevronLeft, ChevronRight, ClipboardCheck, ClipboardList, FileStack, FileText, Flag, FolderOpen, Grid2X2, History, Layers3, LibraryBig, ListChecks, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { Inspector } from './Inspector';
import { Modal } from './Modal';
import { exportReview } from './exportReview';
import {searchRanges} from './searchText';
import { Setup } from './Setup';
import { exampleReview, findingTitle, modeLabels, statusLabels, statusOrder, type Decision, type Evidence, type Mode, type Policy, type Review, type Status } from './review';

type SourceLocation = {doc:Policy;page:number;quote:string;term?:boolean};
type Entry = {key:string;reviewKey:string;finding:string;title:string;mode:Mode;reviewTitle:string;decision:Decision};
const colors:Record<Status,string>={supported:'#a7d4af',mixed:'#e7bb73',contradicted:'#e39988',insufficient:'#aebabe',needs_review:'#c6c3de'};
const currentNav = {workspace:Grid2X2, documents:LibraryBig, log:History};
const navLabels = {workspace:'Workspace', documents:'Documents', log:'Review log'};

function Overview({review}:{review:Review}) {
  const {result,input}=review;
  const counts = statusOrder.map(s=>({s,n:result.findings.filter(f=>f.status===s).length})).filter(o=>o.n);
  let pos = 0;
  const gradient = counts.map(({s,n})=>{
    const start=pos;
    pos += n/result.findings.length*100;
    return `${colors[s]} ${start}% ${Math.max(start,pos-1)}%, #1d4e40 ${Math.max(start,pos-1)}% ${pos}%`;
  }).join(',');
  return <section className="overview" aria-label="Review overview"><div className="paper-art" aria-hidden="true">{Array.from({length:18},(_,i)=><i style={{'--i':i} as CSSProperties} key={i}/>)}</div>
    <div className="overview-main"><div className="overview-label"><FolderOpen size={15}/>Active review<span className="overview-marker">{review.sample?'Synthetic sample':'Custom materials'}</span></div><h2>{review.title}</h2><div className="overview-sub"><span><FileText/>{input.documents.length} {input.documents.length===1?'policy document':'policy documents'}</span><i/><span>{result.engine==='example'?'Prepared example':result.engine==='anthropic'?'Claude assessment':'Keyword retrieval'}</span></div></div>
    <div className="distribution"><div className="ring" style={{background:gradient ? 'conic-gradient('+gradient+')' : '#739385'}}><div><strong>{result.findings.length}</strong><small>findings</small></div></div><div className="legend">{counts.map(({s,n})=><div key={s}><i style={{background:colors[s]}}/><span>{statusLabels[s]}</span><b>{n}</b></div>)}</div></div>
  </section>;
}
function SourceDialog({location,onClose}:{location:SourceLocation;onClose:()=>void}){
  const [pageNumber,setPageNumber]=useState(location.page);
  const index = location.doc.pages.findIndex(p=>p.number===pageNumber);
  const page = location.doc.pages[index];
  const ranges = !location.quote || !page || pageNumber!==location.page ? [] : location.term ? searchRanges(page.text,location.quote) : (()=>{const start=page.text.indexOf(location.quote);return start>=0?[{start,end:start+location.quote.length}]:[];})();
  let lastEnd = 0;
  const content = ranges.flatMap(({start,end})=>{const before=page.text.slice(lastEnd,start);lastEnd=end;return [before,<mark key={start}>{page.text.slice(start,end)}</mark>];});
  return <Modal title={location.doc.title} subtitle="Source document" onClose={onClose} wide>
    <div className="source-toolbar"><span><FileText size={15}/>Page {pageNumber}</span><div><button className="icon-button" disabled={index<=0} aria-label="Previous page" onClick={()=>setPageNumber(location.doc.pages[index-1].number)}><ChevronLeft size={16}/></button><button className="icon-button" disabled={index===-1||index>=location.doc.pages.length-1} aria-label="Next page" onClick={()=>setPageNumber(location.doc.pages[index+1].number)}><ChevronRight size={16}/></button></div></div>
    <div className="source-paper">{page ? <>{content}{page.text.slice(lastEnd)}</> : 'The cited page is unavailable in this review.'}</div>
  </Modal>;
}
function readDecisions():Entry[] {
  try {
    const value = JSON.parse(localStorage.getItem('folio.example-decisions.v1')||'[]');
    return Array.isArray(value) ? value.filter(e=>e && typeof e.key==='string' && typeof e.title==='string' && e.reviewKey?.startsWith('example-') && ['confirmed','flagged'].includes(e.decision?.value) && Number.isFinite(Date.parse(e.decision.at))) : [];
  } catch { return []; }
}
export default function App() {
  const [mode,setMode] = useState<Mode>('questionnaire');
  const [reviews,setReviews] = useState<Record<Mode,Review>>(()=>({questionnaire:exampleReview('questionnaire'),guide:exampleReview('guide')}));
  const [nav,setNav] = useState<keyof typeof navLabels>('workspace'), [setup,setSetup] = useState(false), [source,setSource] = useState<SourceLocation|null>(null);
  const [selected,setSelected]=useState(0),[search,setSearch] = useState(''),[filter,setFilter]=useState<Status|'all'>('all'),[filters,setFilters]=useState(false);
  const [entries,setEntries] = useState<Entry[]>(readDecisions);
  const detailRef = useRef<HTMLDivElement>(null);
  const review=reviews[mode], findings=review.result.findings, current=findings[selected];
  const byKey = new Map(entries.map(e=>[e.key,e]));
  const visible=findings.map((f,i)=>({f,i})).filter(({f})=>(filter==='all'||filter===f.status) && (findingTitle(f)+' '+f.question+' '+f.id).toLowerCase().includes(search.toLowerCase()));
  const reviewed = findings.filter(f=>byKey.has(review.key+'/'+f.id)).length;
  function resetSelection(){setSelected(0);setSearch('');setFilter('all');setFilters(false);}
  function switchMode(m:Mode){if(m!==mode){setMode(m);resetSelection();}}
  function acceptReview(r:Review){setReviews(prev=>({...prev,[r.input.mode]:r}));setMode(r.input.mode);setNav('workspace');resetSelection();setSetup(false);}
  function openEvidence(e:Evidence,term=false){const doc=review.input.documents.find(d=>d.id===e.documentId);if(doc)setSource({doc,page:e.page,quote:e.quote,term});}
  function decide(value?:Decision['value']){
    if(!current)return;
    const key=review.key+'/'+current.id;
    const next=entries.filter(e=>e.key!==key);
    if(value)next.unshift({key,reviewKey:review.key,finding:current.id,title:findingTitle(current),mode,reviewTitle:review.title,decision:{value,at:new Date().toISOString()}});
    setEntries(next);
    try{localStorage.setItem('folio.example-decisions.v1',JSON.stringify(next.filter(e=>e.reviewKey.startsWith('example-'))));}catch{/* Decisions remain in this tab. */}
  }
  return <><a href="#main" className="skip-link">Skip to content</a>
    <header className="app-header"><div className="header-inner"><a href="#main" className="brand" onClick={()=>setNav('workspace')} aria-label="Folio workspace"><span className="brand-icon"><Layers3 size={24} strokeWidth={2}/></span>Folio</a>
      <div className="nav-separator"/><nav aria-label="Primary">{(Object.keys(navLabels) as (keyof typeof navLabels)[]).map(n=>{const Icon=currentNav[n];return <button key={n} className={n===nav?'active':''} aria-current={n===nav?'page':undefined} onClick={()=>setNav(n)}><Icon size={16}/>{navLabels[n]}</button>;})}</nav>
      <div className="header-end"><span className="brand-dot"/>Compliance workspace</div></div>
    </header>
    <main id="main"><div className="page-heading"><div><div className="crumb"><Layers3 size={13}/>Folio <ChevronRight size={12}/>{navLabels[nav]}</div><h1>{nav==='workspace'?'Policy review':nav==='documents'?'Source documents':'Review log'}</h1><p>{nav==='workspace'?'Trace each requirement to the policy language behind it.':nav==='documents'?'Read the policy pages included in the active review.':'Inspect the latest decision recorded for each finding.'}</p></div><button className="primary new-review" onClick={()=>setSetup(true)}><Plus size={17}/>New review</button></div>
    {nav!=='log' && <div className="mode-tabs" aria-label="Review mode">{(['questionnaire','guide'] as const).map(m=>{const Icon=m==='guide'?BookOpenText:ClipboardList;return <button key={m} className={m===mode?'selected':''} aria-pressed={m===mode} onClick={()=>switchMode(m)}><Icon size={16}/>{modeLabels[m]}</button>;})}</div>}
    {nav==='workspace' && <>
      <Overview review={review}/>
      {review.result.engine!=='example' && <div className="run-notice"><FileStack size={16}/><span>{review.result.notice}{review.scope && ` Search covers ${review.scope.selectedPages} selected pages from ${review.scope.sourcePages.toLocaleString()} source pages.`}</span></div>}
      <div className="work-grid"><aside className="queue panel"><div className="queue-head"><div className="section-title"><ListChecks size={19}/><h2>Review queue</h2><span className="count">{findings.length}</span></div><div className="queue-controls"><label className="queue-search"><Search size={15}/><input aria-label="Search findings" placeholder="Search findings…" value={search} onChange={e=>setSearch(e.target.value)}/>{search && <button aria-label="Clear search" onClick={()=>setSearch('')}><X size={13}/></button>}</label><button className={'filter-button '+(filters||filter!=='all'?'active':'')} aria-label="Filter by finding status" aria-expanded={filters} onClick={()=>setFilters(!filters)}><SlidersHorizontal size={16}/></button></div>{filters && <label className="filter-select">Status<select value={filter} onChange={e=>setFilter(e.target.value as Status|'all')}><option value="all">All statuses</option>{statusOrder.map(s=><option key={s} value={s}>{statusLabels[s]}</option>)}</select></label>}</div>
       <div className="queue-items">{visible.map(({f,i})=>{const decision=byKey.get(review.key+'/'+f.id)?.decision;return <button className={'queue-row '+(i===selected?'selected':'')} key={f.id} aria-pressed={i===selected} onClick={()=>{setSelected(i);if(window.matchMedia('(max-width: 760px)').matches)requestAnimationFrame(()=>detailRef.current?.scrollIntoView({behavior:'smooth',block:'start'}));}}>
         <span className="row-top"><span className="short-id">{mode==='questionnaire'?'Q':'R'}-{String(i+1).padStart(2,'0')}</span><span className={'row-status '+f.status}><i/>{statusLabels[f.status]}</span>{decision && (decision.value==='confirmed'?<Check size={13} aria-label="Confirmed"/>:<Flag size={13} aria-label="Flagged"/>)}</span><span className="row-name">{findingTitle(f)}</span></button>;})}
       {!visible.length && <div className="empty-list"><Search size={20}/><p>No matching findings</p>{(search||filter!=='all')&&<button className="text-link" onClick={()=>{setSearch('');setFilter('all');}}>Clear filters</button>}</div>}</div><div className="queue-footer"><ClipboardCheck size={15}/>{reviewed} of {findings.length} reviewed<span className="progress"><i style={{width:(reviewed/Math.max(findings.length,1)*100)+'%'}}/></span></div>
       </aside><div ref={detailRef} className="detail-wrap">{current ? <Inspector key={review.key+'/'+current.id} finding={current} mode={mode} documents={review.input.documents} onOpen={openEvidence} index={selected} decision={byKey.get(review.key+'/'+current.id)?.decision} decide={decide} prepared={review.result.engine==='example'}/> : <div className="panel empty-list"><BookOpen/><p>No requirements extracted from this input.</p></div>}</div></div>
    </>}
    {nav==='documents' && <section className="panel library"><header><div className="section-title"><LibraryBig size={19}/><h2>{review.title}</h2></div><span>{review.input.documents.length} documents</span></header>{review.input.documents.map(doc=><button className="library-row" key={doc.id} onClick={()=>setSource({doc,page:doc.pages[0].number,quote:''})}><span className="doc-icon"><FileText size={22}/></span><span><strong>{doc.title}</strong><small>{doc.pages.length} {doc.pages.length===1?'page':'pages'} in review</small></span><ChevronRight size={17}/></button>)}</section>}
    {nav==='log' && <section className="panel library"><header><div className="section-title"><History size={19}/><h2>Reviewer decisions</h2></div><span>{entries.length} recorded</span></header>{entries.length ? entries.map(e=><div className="log-row" key={e.key}><span className={'decision-tag '+e.decision.value}>{e.decision.value==='confirmed'?<Check size={16}/>:<Flag size={15}/>}</span><div><strong>{e.title}</strong><p>{e.reviewTitle} · {modeLabels[e.mode]} · {e.decision.value==='confirmed'?'Confirmed':'Flagged for follow-up'}</p></div><time dateTime={e.decision.at}>{new Date(e.decision.at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time></div>):<div className="empty-state"><ClipboardCheck size={30}/><h3>No decisions yet</h3><p>Confirm a finding or flag it for follow-up in the workspace.</p><button className="secondary" onClick={()=>setNav('workspace')}>Open workspace</button></div>}
      <p className="log-hint">Prepared example decisions are saved in this browser. Decisions from new reviews stay in this tab.</p></section>}
    <footer className="app-footer"><span><Layers3 size={14}/>Folio</span><button className="text-link" onClick={()=>exportReview(review,byKey)}><Download size={14}/>Download current report</button></footer>
    </main>{setup && <Setup initialMode={mode} onClose={()=>setSetup(false)} onDone={acceptReview}/>} {source && <SourceDialog location={source} onClose={()=>setSource(null)}/>}
  </>;
}
