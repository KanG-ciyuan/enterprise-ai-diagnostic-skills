// Read-only projection of server-stored employee statements. Raw answers,
// evidence digests, inference judgments and append-only history remain unchanged.
const DIMENSIONS = ['trigger','inputs','steps','judgments','exceptions','handoff','burden'];
const clean = value => String(value ?? '').normalize('NFC').replace(/\r\n/g,'\n').trim();
const sentences = text => text.match(/[^。！？；\n]+[。！？；\n]?/gu) || [];
const correctionCue = /(?:刚才|之前|前面|原先).{0,45}(?:不准确|不够准确|不对|有误|说错)|(?:更正|纠正|请改为)/u;
const unknownCue = /不知道|不太清楚|不清楚|记不清|记不准|说不准(?!\s*(?:就|则|时))|拿不准(?!\s*(?:就|则|时))|说不好|(?:我|本人)(?:也|还|目前)?不确定|无法确认|(?:没|没有|未)(?:实际|亲自)?(?:处理|经历|接触)过|未经历|没见过|没问过|不了解|不能确认|不能证明|没统计|未统计|没计时|未计时|没有.{0,12}(?:统计|计时|记录|制度)|(?:未|没|没有)拿到.{0,12}(?:确认|批准)|只是印象|凭印象|只是估计/u;
const grams = text => {
  const value=clean(text).replace(/[\s，。、；：“”「」,.:;!?！？]/gu,'');
  return new Set(Array.from({length:Math.max(0,value.length-1)},(_,i)=>value.slice(i,i+2)));
};

/** Input must be server-stored answers/history, never a client-supplied ledger. */
export function deriveInterviewRecord(answers = {}, history = []) {
  const entries=[];
  for(const h of Array.isArray(history)?history:[]) {
    if(!h || !DIMENSIONS.includes(h.dimension) || !clean(h.text)) continue;
    entries.push({dimension:h.dimension,text:clean(h.text),kind:h.kind||'supplement',seq:h.seq||entries.length+1});
  }
  for(const dimension of DIMENSIONS) {
    const text=clean(answers[dimension]);
    if(!text) continue;
    const last=entries.filter(e=>e.dimension===dimension).at(-1);
    if(!last || last.kind==='withdrawn' || last.text!==text) entries.push({dimension,text,kind:last?'supplement':'initial',seq:entries.reduce((n,e)=>Math.max(n,e.seq),0)+1});
  }
  // A withdrawal removes the old account from the current card, never from history.
  const active=[];
  for(const e of entries) {
    if(e.kind==='withdrawn') {
      for(let i=active.length-1;i>=0;i--) if(active[i].dimension===e.dimension) active.splice(i,1);
    } else if(clean(answers[e.dimension])) active.push(e);
  }
  const parts=[];
  const corrections=[];
  for(const entry of active) {
    const cue=entry.text.match(correctionCue) || (entry.kind==='correction'?{index:0}:null);
    if(cue) {
      // Only locate the employee's correction target. Never ask a model to erase
      // or rewrite earlier steps. Ambiguous matches remain explicitly pending.
      const named=entry.text.match(/(?:刚才|之前|前面|原先)(?:说的|说|提到)?[“「]?(.{2,40}?)(?:[”」]?(?:不准确|不够准确|不对|有误|说错))/u)?.[1];
      const target=named && !/^(?:那句话|那句|的说法)$/u.test(named) ? named : '';
      const wanted=grams(target);
      let best=null,score=0;
      if(wanted.size>=2) for(const p of parts) {
        const got=grams(p.text),hits=[...wanted].filter(g=>got.has(g)).length;
        const ratio=hits/wanted.size;
        if(hits>=2 && ratio>=0.45 && ratio>score) {best=p;score=ratio;}
      }
      const correction={entry,dimension:best?.dimension||entry.dimension,text:entry.text.slice(cue.index),old:best};
      if(best) best.correctedBy=correction;
      // An explicit, server-issued dimension-correction intent applies to that
      // dimension's earlier account. Keep its text labelled, never delete it.
      if(entry.kind==='correction' && !target) for(const p of parts) if(p.dimension===entry.dimension) p.correctedBy=correction;
      corrections.push(correction);
    }
    for(const text of sentences(entry.text)) {
      if(!parts.some(p=>p.dimension===entry.dimension && clean(p.text)===clean(text))) parts.push({dimension:entry.dimension,text:clean(text),entry});
    }
  }
  const dimensions={};
  for(const dimension of DIMENSIONS) {
    const own=parts.filter(p=>p.dimension===dimension);
    // Preserve the exact single answer for legacy cards and existing contracts.
    const related=corrections.filter(c=>c.dimension===dimension);
    const multi=active.filter(e=>e.dimension===dimension).length>1;
    dimensions[dimension]=!multi && !related.length ? clean(answers[dimension]) : own.map(p=>
      `${p.correctedBy?'【原口径，员工已提出修正，不作为当前定论】':''}${p.text}`
    ).join('\n');
    for(const c of related) dimensions[dimension]+=`\n【员工修正，待本人确认及证据核验】${c.text}`;
    dimensions[dimension]=dimensions[dimension].trim();
  }
  const unresolved=[];
  const add=(dimension,quote,kind,seq,sourceDimension=dimension)=>{
    if(unresolved.some(u=>u.dimension===dimension&&u.quote===quote&&u.kind===kind))return;
    unresolved.push({key:dimension,dimension,sourceDimension,kind,quote,statementSeq:seq,
      reason:(kind==='correction'?'员工修正口径，需复核：':'员工明确未知或尚无依据：')+quote,
      requestedFrom:'流程核验人员（协调相关责任人）',
      evidenceNeeded:'对应的系统记录、授权材料或独立人员说明；员工陈述仍为 E3',source:'server_employee_history'});
  };
  for(const p of parts) if(!p.correctedBy && unknownCue.test(p.text)) add(p.dimension,p.text,'unknown',p.entry.seq);
  for(const c of corrections) add(c.dimension,c.text,'correction',c.entry.seq,c.entry.dimension);
  const presentation=currentInterviewPresentation(parts,corrections,answers);
  return {dimensions,unresolved,...presentation,unresolvedGroups:groupInterviewUnresolved(unresolved)};
}

export function interviewUnresolved(record, legacy = []) {
  const out=[...record.unresolved];
  for(const u of Array.isArray(legacy)?legacy:[]) if(u && DIMENSIONS.includes(u.dimension||u.key)
    && !out.some(x=>x.dimension===(u.dimension||u.key)&&x.reason===u.reason)) out.push(u);
  return out;
}

// Conservative display grouping. Different dimensions, kinds, identifiers,
// amounts, subjects or question facets never collapse into a single action.
export function groupInterviewUnresolved(unresolved = []) {
  const groups=[];
  for(const u of unresolved) {
    const text=clean(u.quote||u.reason),lower=text.toLowerCase();
    let subject='',facet='';
    if(/wms/.test(lower) && /批准人|审批人/.test(text) && /(?:是否.{0,8}(?:记|留)|留不留|记不记|有没有.{0,8}记录)/u.test(text) && !/怎么|如何|多久|何时|修改|删除|权限|退款|货损/u.test(text)) {subject='WMS 审批人';facet='记录是否留存';}
    const identifiers=(text.match(/[A-Z]+[-_]?[A-Z]*\d+|\d+(?:\.\d+)?\s*(?:元|天|分钟|件)/g)||[]).sort().join('|');
    const key=subject ? [u.dimension||u.key,u.kind||'unknown',subject,facet,identifiers].join('|') : null;
    let g=key && groups.find(g=>g.groupKey===key);
    if(!g){g={groupKey:key||`source-${groups.length}`,dimension:u.dimension||u.key,kind:u.kind||'unknown',summary:subject?`${subject}：${facet}，待核实`:text,sources:[]};groups.push(g);}
    g.sources.push({...u});
  }
  return groups;
}
function currentInterviewPresentation(parts, corrections, answers) {
  const currentText = text => {
    // Keep the employee's exact replacement clause after an explicit correction.
    // “更正后的订单” is a business object, not an instruction to erase the step.
    const explicit = /(?:刚才|之前|前面|原先).{0,45}(?:不准确|不够准确|不对|有误|说错)|^(?:更正|纠正)[:：，]|请改为/u.test(text);
    if (explicit) {
      const replacement = text.match(/(?:不准确|不够准确|不对|有误|说错|更正|纠正)[:：，,]([\s\S]+)/u);
      return replacement && !/^(?:是)?旧.{0,12}说法/u.test(clean(replacement[1])) ? clean(replacement[1]) : '';
    }
    return /(?:前面|刚才|之前|原先|原来|旧).*(?:撤回|作废|旧.{0,8}说法|不作为|不再.{0,8}依据)/u.test(text) ? '' : text;
  };
  const current=[];
  for(const p of parts) {
    const text=currentText(p.text);
    if(p.correctedBy || !text) continue;
    let dimension=p.dimension;
    if(dimension==='trigger' && /权限|批准|审批/.test(p.text) && !/收到|出现|开始/.test(p.text)) dimension='judgments';
    const c=corrections.find(c=>c.entry.seq===p.entry.seq && c.old && c.entry.text.indexOf(p.text)+p.text.length>c.entry.text.indexOf(c.text));
    if(c) {
      dimension=c.dimension;
      // A permission correction is a decision boundary, not a new trigger.
      if(dimension==='trigger' && /权限|批准|审批|退款/.test(c.old.text)) dimension='judgments';
    }
    if(!current.some(x=>x.dimension===dimension && x.text===text))current.push({dimension,text,statementSeq:p.entry.seq,sourceDimension:p.dimension,source:'server_employee_history'});
  }
  const currentDimensions={};
  for(const dimension of DIMENSIONS) {
    const rows=current.filter(p=>p.dimension===dimension);
    const untouched=!corrections.some(c=>c.dimension===dimension||c.entry.dimension===dimension)
      && !parts.some(p=>p.dimension===dimension&&p.correctedBy)
      && !current.some(p=>(p.dimension===dimension||p.sourceDimension===dimension)&&p.sourceDimension!==p.dimension);
    const single=parts.filter(p=>p.dimension===dimension).every(p=>p.entry.seq===parts.find(x=>x.dimension===dimension)?.entry.seq);
    currentDimensions[dimension]=untouched&&single ? clean(answers[dimension]) : rows.map(p=>p.text).join('\n');
  }
  return {currentDimensions,currentStatements:current};
}
