const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {DOMParser}=require('linkedom');
const G=require('../extension/guard.js');
const initial=()=>G.normalizeConfig({term:'20271',targets:[{course:'CSCI-587',sections:[{id:'30306',units:'4'}]}]});
const section=(id='30500',units=['4'],type='Lecture')=>({id,type,units,instructors:'Test Instructor',days:'MW',time:'14:00-15:50',location:'TBA',registered:75,total:75,open:false,cancelled:false});
function harness(options={}){
  const document=new DOMParser().parseFromString(fs.readFileSync('extension/popup.html','utf8'),'text/html');
  // linkedom does not implement writable select.value for dynamic unit pickers.
  Object.defineProperty(Object.getPrototypeOf(document.createElement('select')),'value',{configurable:true,get(){return this._value??this.querySelector('option')?.getAttribute('value')??'';},set(value){this._value=String(value);}});
  let config=initial(),state={phase:options.phase||'idle',config,tabId:7,journal:options.journal||null,attempt:options.attempt||null,targetStates:{},results:{},message:'Test status'},refresh;
  let timerId=0;const timers=new Map(),calls=[];
  const courses=options.courses||[{code:'EE-450',title:'Introduction to Computer Networks'}];
  const chrome={tabs:{query:async()=>[{id:7,title:'WebReg: Checkout'}]},runtime:{sendMessage:async message=>{
    calls.push(structuredClone(message));
    if(message.type==='status')return structuredClone(state);
    if(message.type==='load-config')return structuredClone(config);
    if(message.type==='save-config'){config=message.config.targets.length?G.normalizeConfig(message.config):message.config;state={...state,config};return structuredClone(config);}
    if(message.type==='search-courses'){
      if(options.searchHook)return options.searchHook(message);
      if(options.searchError)throw Error(options.searchError);
      return {courses:structuredClone(courses),total:courses.length};
    }
    if(message.type==='course-sections'){
      if(options.sectionHook)return options.sectionHook(message);
      return {term:message.term,code:message.course,title:courses.find(c=>c.code===message.course)?.title,sections:structuredClone(options.sections||[section()])};
    }
    if(message.type==='resolve-target'){
      if(options.resolveHook)await options.resolveHook();
      return G.normalizeConfig({term:message.term,targets:[{course:message.course,sections:message.sectionIds.map((id,i)=>({id,units:message.units[i]})),grade:message.grade}]}).targets[0];
    }
    if(message.type==='arm'){state={...state,phase:'watching'};return structuredClone(state);}
    if(message.type==='stop'){state={...state,phase:'idle'};return structuredClone(state);}
    if(message.type==='acknowledge-review'){state={...state,phase:'idle',attempt:null,journal:null};return structuredClone(state);}
    if(message.type==='cleanup'){state={...state,phase:'idle',journal:null};return structuredClone(state);}
    throw Error('Unknown command '+message.type);
  }}};
  const context=vm.createContext({document,chrome,console,setInterval:fn=>{refresh=fn;return 1;},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(fs.readFileSync('extension/popup.js','utf8'),context);
  const flush=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
  const fire=(id,type)=>document.getElementById(id).dispatchEvent(new document.defaultView.Event(type,{bubbles:true,cancelable:true}));
  const tick=()=>{const pending=[...timers.values()];timers.clear();for(const fn of pending)void fn();};
  const search=async query=>{document.getElementById('search').value=query;fire('search','input');tick();await flush();};
  const choose=async(index=0)=>{document.querySelectorAll('.course-result')[index].click();await flush();};
  const check=(id,value=true)=>{const item=document.getElementById('choose-section-'+id);item.checked=value;fire(item.id,'change');};
  return {document,calls,flush,fire,tick,search,choose,check,refresh:()=>refresh(),get config(){return config;},get state(){return state;}};
}
test('popup reopens with saved active status and locks search without adding an auto-submit checkbox',async()=>{
  const h=harness({phase:'watching'});await h.flush();const d=h.document;
  assert.match(d.getElementById('phase').textContent,/is ON/);assert.equal(d.getElementById('consent'),null);assert.equal(d.getElementById('search').disabled,true);
  assert.ok(d.body.innerHTML.indexOf('id="arm"')<d.body.innerHTML.indexOf('id="watchlist"'));
});
test('user searches a title, picks its only section, and adds it without typing IDs or fixed units',async()=>{
  const h=harness();await h.flush();await h.search('computer networks');assert.equal(h.document.querySelectorAll('.course-result').length,1);
  await h.choose();assert.equal(h.document.getElementById('choose-section-30500').checked,true);assert.equal(h.document.getElementById('add-course').disabled,false);
  h.fire('add-course','click');await h.flush();assert.deepEqual(Array.from(h.config.targets,t=>t.course),['CSCI-587','EE-450']);
  const resolve=h.calls.find(c=>c.type==='resolve-target');assert.deepEqual(resolve.sectionIds,['30500']);assert.deepEqual(resolve.units,['4']);
  assert.equal(h.document.getElementById('sections'),null);assert.equal(h.document.getElementById('units'),null);
});
test('multiple components require explicit selection and pass their actual fixed and zero units',async()=>{
  const h=harness({sections:[section('30500',['4']),section('30501',['0'],'Lab'),section('30502',['0'],'Lab')]});await h.flush();await h.search('EE');await h.choose();
  assert.equal(h.document.getElementById('choose-section-30500').checked,false);assert.equal(h.document.getElementById('add-course').disabled,true);
  h.check('30500');h.check('30501');h.fire('add-course','click');await h.flush();
  const resolve=h.calls.find(c=>c.type==='resolve-target');assert.deepEqual(resolve.sectionIds,['30500','30501']);assert.deepEqual(resolve.units,['4','0']);
});
test('variable units are never silently chosen for the user',async()=>{
  const h=harness({sections:[section('30500',['1','2','4'])]});await h.flush();await h.search('EE');await h.choose();
  assert.equal(h.document.getElementById('add-course').disabled,true);const units=h.document.getElementById('section-units-30500');assert.equal(units.value,'');units.value='2';h.fire(units.id,'change');assert.equal(h.document.getElementById('add-course').disabled,false);
});
test('searches are debounced and late older results cannot replace a newer query',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);
  const h=harness({searchHook:async m=>m.query==='old'?pending:{courses:[{code:'MATH-225',title:'Linear Algebra'}],total:1}});await h.flush();
  h.document.getElementById('search').value='o';h.fire('search','input');h.tick();await h.flush();assert.equal(h.calls.filter(c=>c.type==='search-courses').length,0);
  await h.search('old');await h.search('new');release({courses:[{code:'EE-450',title:'Old result'}],total:1});await h.flush();
  assert.match(h.document.getElementById('course-results').textContent,/MATH 225/);assert.doesNotMatch(h.document.getElementById('course-results').textContent,/Old result/);
});
test('a late section response cannot replace a newly chosen course',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);
  const courses=[{code:'EE-450',title:'Networks'},{code:'MATH-225',title:'Linear Algebra'}];
  const h=harness({courses,sectionHook:async m=>m.course==='EE-450'?pending:{term:m.term,code:m.course,title:'Linear Algebra',sections:[section('39500')]}});await h.flush();await h.search('EE');await h.choose(0);await h.search('MATH');await h.choose(1);
  release({term:'20271',code:'EE-450',title:'Networks',sections:[section()]});await h.flush();assert.match(h.document.getElementById('selected-course-name').textContent,/MATH 225/);
});
test('semester dropdown uses readable names and changing it explicitly clears the old selections',async()=>{
  const h=harness();await h.flush();const term=h.document.getElementById('term');assert.equal(term.tagName,'SELECT');assert.match(term.textContent,/Spring 2027/);
  term.value='20273';h.fire('term','change');assert.equal(h.document.getElementById('search').disabled,true);h.fire('save-term','click');await h.flush();
  assert.equal(h.config.term,'20273');assert.equal(h.config.targets.length,0);assert.equal(h.document.getElementById('arm').disabled,true);
});
test('Stop interrupts pending Add verification and cannot save its late result',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);const h=harness({resolveHook:async()=>pending});await h.flush();await h.search('EE');await h.choose();h.fire('add-course','click');await h.flush();h.fire('stop','click');release();await h.flush();
  assert.equal(h.config.targets.length,1);assert.equal(h.calls.filter(c=>c.type==='save-config').length,0);
});
test('pending submission review locks course changes and takes priority over restoration',async()=>{
  const h=harness({phase:'paused',journal:{removed:[],added:[]},attempt:{id:'attempt'}});await h.flush();const d=h.document;
  assert.equal(d.getElementById('review-panel').hidden,false);assert.equal(d.getElementById('cleanup-panel').hidden,true);assert.equal(d.getElementById('search').disabled,true);
  h.fire('review','click');await h.flush();assert.ok(h.calls.some(c=>c.type==='acknowledge-review'));assert.equal(d.getElementById('search').disabled,false);
});
test('polling preserves search text and chosen section checkboxes',async()=>{
  const h=harness({sections:[section('30500'),section('30501',['0'],'Lab')]});await h.flush();await h.search('Networks');await h.choose();h.check('30501');await h.refresh();await h.flush();
  assert.equal(h.document.getElementById('search').value,'Networks');assert.equal(h.document.getElementById('choose-section-30501').checked,true);
});
test('full sections are watchable while cancelled sections cannot be selected',async()=>{
  const h=harness({sections:[section('30500'),{...section('30501'),cancelled:true}]});await h.flush();await h.search('EE');await h.choose();
  assert.equal(h.document.getElementById('choose-section-30500').disabled,false);assert.equal(h.document.getElementById('choose-section-30501').disabled,true);
});
test('search errors survive status polling and external course titles are rendered only as text',async()=>{
  const failed=harness({searchError:'USC lookup timed out'});await failed.flush();await failed.search('EE');await failed.refresh();await failed.flush();assert.match(failed.document.getElementById('search-message').textContent,/timed out/);
  const safe=harness({courses:[{code:'EE-450',title:'<img src=x onerror=alert(1)>'}]});await safe.flush();await safe.search('EE');assert.equal(safe.document.querySelector('#course-results img'),null);assert.match(safe.document.getElementById('course-results').textContent,/<img/);
});
