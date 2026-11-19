const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const G = require('../extension/guard.js');
const config = () => G.normalizeConfig({ term:'20271', targets:[
  {course:'CSCI-587',sections:[{id:'30306',units:'4'}],grade:'L'},
  {course:'DSCI-556',sections:[{id:'32406',units:'4'}],grade:'L'}
] });
const row = (section,course,scheduled=true,registered=false) => ({section,course,scheduled,registered,units:'4',grade:'L'});
function harness(options={}) {
  let now=Date.now(), url='https://webreg.usc.edu/CourseBin', loading=false;
  let rows=structuredClone(options.rows || [row('30306','CSCI-587'),row('32406','DSCI-556'),row('30390','CSCI-580',true,true)]);
  const cfg=options.config || config();
  const storage={config:cfg,...structuredClone(options.storage || {})};
  const sessionStorage=options.sessionStore || {};
  const logs={mutations:[],submits:[],lookups:[],navigation:[],notifications:[]};
  const handlers={};
  const event=name=>({addListener:fn=>(handlers[name] ||= []).push(fn)});
  const emit=(name,...args)=>{for(const fn of handlers[name] || [])void fn(...args);};
  const isOpen=course=>typeof options.open==='function'?options.open(course):course==='CSCI-587'||options.bothOpen;
  const bin=()=>({term:G.termLabel(cfg.term),rows:structuredClone(rows)});
  const checkout=()=>{
    const pending=rows.filter(r=>r.scheduled&&!r.registered);
    return {path:'/Checkout',term:G.termLabel(cfg.term),headings:pending.length?['You are about to REGISTER for the following sections:']:[],
      courses:[...new Set(pending.map(r=>r.course))],rows:pending.map(r=>({...r,grade:r.grade==='L'?'Letter Grade':r.grade,seatText:isOpen(r.course)?'74 of 75':'Closed'})),
      submit:!!pending.length,action:'/CheckoutResponse',method:'post'};
  };
  const navigate=(next)=>{url=next;loading=true;logs.navigation.push(next);setImmediate(()=>{loading=false;emit('updated',7,{status:'complete'});});};
  const chrome={runtime:{id:'test',onMessage:event('message'),onStartup:event('startup'),onInstalled:event('installed')},
    storage:{local:{get:async()=>structuredClone(storage),set:async v=>{if(options.beforeSet)await options.beforeSet(v);Object.assign(storage,structuredClone(v));}}},
    action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},notifications:{create:async msg=>logs.notifications.push(msg.message)},
    power:{requestKeepAwake:()=>{},releaseKeepAwake:()=>{}},alarms:{get:async()=>true,clear:async()=>{},create:async()=>{},onAlarm:event('alarm')},
    tabs:{get:async()=>({url,status:loading?'loading':'complete'}),query:async()=>[],onUpdated:event('updated'),onRemoved:event('removed'),
      update:async(id,changes)=>{if(changes.url)navigate(changes.url);},reload:async()=>navigate(url),
      sendMessage:async(id,message)=>{
        if(options.contentHook){const result=await options.contentHook(message,{storage,rows,logs,bin,checkout});if(result!==undefined)return result;}
        if(message.type==='read-bin')return bin();
        if(message.type==='read-checkout'||message.type==='live-checkout')return checkout();
        if(message.type==='page-info')return {path:new URL(url).pathname,term:G.termLabel(cfg.term)};
        if(message.type==='mutate'){
          const state=storage.state, op=state.pendingMutation;
          assert.ok(op?.id===message.operationId,'mutation intent must be durable before any click');
          assert.ok(state.journal,'original selections must be journaled before any change');
          if(options.beforeMutation)await options.beforeMutation(op,{storage,logs,rows});
          if(storage.state.phase==='paused'||storage.state.pendingMutation?.id!==op.id)return {error:'Cancelled'};
          let item=rows.find(r=>r.section===op.section);
          assert.ok(!item?.registered,'must never mutate a registered section');
          logs.mutations.push({...op});
          if(op.kind==='add'){if(!item){item=row(op.section,op.course,false);rows.push(item);}}
          else item.scheduled=op.kind==='schedule';
          if(options.mutationError)return {error:'Unknown server result'};
          return {confirmed:true};
        }
        if(message.type==='submit'){
          const state=storage.state,target=state.config.targets.find(t=>t.id===state.activeTarget);
          assert.ok(state.attempt?.id===message.attemptId,'claim must persist before Submit');
          assert.equal(G.validateCheckout(checkout(),target,cfg.term,true),null,'checkout must contain exactly one available target bundle');
          logs.submits.push({ids:checkout().rows.map(r=>r.section),course:target.course});
          if(options.confirm!==false)for(const component of target.sections)rows.find(r=>r.section===component.id).registered=true;
          if(options.lostSubmitAck)throw new Error('Message port closed');
          navigate('https://webreg.usc.edu/CheckoutResponse');
          return {clicked:true};
        }
        if(message.type==='recover-term')return {selected:true};
        throw new Error('Unknown fake content command '+message.type);
      }}
  };
  chrome.storage.session={get:async()=>structuredClone(sessionStorage),set:async value=>Object.assign(sessionStorage,structuredClone(value))};
  class FakeDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context=vm.createContext({chrome,console,URL,URLSearchParams,AbortSignal,Date:FakeDate,structuredClone,crypto:require('node:crypto').webcrypto,
    fetch:async input=>{
      const parsed=new URL(input),course=parsed.searchParams.get('courseCode');logs.lookups.push(course);
      if(options.fetcher)return options.fetcher(input,{logs});
      if(parsed.pathname.endsWith('/Autocomplete'))return {ok:true,json:async()=>({termCode:cfg.term,courses:(options.catalog || [
        {code:'CSCI-587',title:'Geospatial Data Analysis'},{code:'DSCI-556',title:'User Experience Design and Strategy'},{code:'EE-450',title:'Introduction to Computer Networks'}
      ]).map(item=>({scheduledCourseCode:{courseHyphen:item.code},name:item.title,termCode:cfg.term}))})};
      const targets=cfg.targets.filter(t=>t.course===course);
      return {ok:true,json:async()=>({termCode:cfg.term,scheduledCourseCode:{courseHyphen:course},sections:targets.flatMap(t=>t.sections.map(s=>({sisSectionId:s.id,termCode:cfg.term,totalSeats:75,registeredSeats:isOpen(course)?74:75,isFull:!isOpen(course),isCancelled:false,units:[s.units]})))})};
    }});
  context.importScripts=(...files)=>{for(const file of files)vm.runInContext(fs.readFileSync('extension/'+file,'utf8'),context);};
  vm.runInContext(fs.readFileSync('extension/worker.js','utf8'),context);
  const command=message=>new Promise(resolve=>handlers.message[0](message,{id:'test'},resolve));
  const flush=async(n=150)=>{for(let i=0;i<n;i++)await new Promise(r=>setImmediate(r));};
  return {command,flush,logs,storage,sessionStorage,rows,emit,advance:ms=>now+=ms,setUrl:value=>url=value,get state(){return storage.state;}};
}
test('an open CSCI target checks out alone while closed DSCI and unrelated selections are restored',async()=>{
  const h=harness({rows:[row('30306','CSCI-587'),row('32406','DSCI-556'),row('40123','MATH-225'),row('30390','CSCI-580',true,true)]});
  await h.command({type:'arm',tabId:7});await h.flush();
  assert.deepEqual(h.logs.submits,[{ids:['30306'],course:'CSCI-587'}]);
  assert.ok(h.rows.find(r=>r.section==='30306').registered);
  for(const id of ['32406','40123'])assert.equal(h.rows.find(r=>r.section===id).scheduled,true);
  assert.equal(h.state.journal,null);assert.equal(h.state.attempt,null);assert.equal(h.state.phase,'watching');
  assert.ok(!h.logs.mutations.some(op=>op.section==='30390'));
});
test('two available departments use two separate confirmed checkouts',async()=>{
  const h=harness({bothOpen:true});await h.command({type:'arm',tabId:7});await h.flush(250);
  assert.deepEqual(h.logs.submits.map(s=>s.ids),[['30306'],['32406']]);
  assert.equal(h.state.phase,'complete');assert.equal(h.state.journal,null);assert.equal(h.state.attempt,null);
});
test('missing target is added, scheduled, registered, and never batches a closed target',async()=>{
  const h=harness({rows:[row('32406','DSCI-556')]});await h.command({type:'arm',tabId:7});await h.flush();
  assert.deepEqual(h.logs.mutations.filter(op=>op.section==='30306').map(op=>op.kind),['add','schedule']);
  assert.deepEqual(h.logs.submits.map(s=>s.ids),[['30306']]);assert.equal(h.rows.find(r=>r.section==='32406').scheduled,true);
});
test('uncertain submission blocks later courses and persists its restoration journal',async()=>{
  const h=harness({bothOpen:true,confirm:false});await h.command({type:'arm',tabId:7});await h.flush();
  assert.equal(h.state.phase,'submitted');assert.equal(h.logs.submits.length,1);
  h.advance(46000);h.emit('alarm',{name:'seat-check'});await h.flush();
  assert.equal(h.state.phase,'paused');assert.ok(h.state.attempt);assert.ok(h.state.journal);
  h.emit('alarm',{name:'seat-check'});await h.flush();assert.equal(h.logs.submits.length,1);
  assert.match((await h.command({type:'arm',tabId:7})).error,/recovery/);
});
test('lost submit acknowledgment is verified by USC enrollment without replay',async()=>{
  const h=harness({lostSubmitAck:true});await h.command({type:'arm',tabId:7});await h.flush();
  assert.equal(h.logs.submits.length,1);assert.equal(h.state.targetStates[config().targets[0].id].status,'registered');assert.equal(h.state.attempt,null);
});
test('a failed mutation retains the intent and newly written journal for manual recovery',async()=>{
  const h=harness({mutationError:true});await h.command({type:'arm',tabId:7});await h.flush();
  assert.equal(h.state.phase,'paused');assert.ok(h.state.pendingMutation);assert.equal(h.state.journal.removed[0].section,'32406');assert.equal(h.logs.submits.length,0);
  await h.command({type:'cleanup',tabId:7});await h.flush();
  // Repeated uncertainty in the fake server must still retain recovery data.
  assert.ok(h.state.journal);assert.equal(h.logs.submits.length,0);
});
test('Stop while a mutation is pending retains uncertainty instead of clearing the journal',async()=>{
  let release,entered=false;const pending=new Promise(resolve=>release=resolve);
  const h=harness({beforeMutation:async()=>{entered=true;await pending;}});
  await h.command({type:'arm',tabId:7});await h.flush();assert.ok(entered);
  await h.command({type:'stop'});release();await h.flush();
  assert.equal(h.state.phase,'paused');assert.ok(h.state.pendingMutation);assert.ok(h.state.journal);assert.equal(h.logs.submits.length,0);
});
test('Stop during a public lookup prevents checkout and stale state resurrection',async()=>{
  let release,entered=false;const pending=new Promise(resolve=>release=resolve);
  const h=harness({fetcher:async()=>{entered=true;await pending;throw new Error('Network timeout');}});
  await h.command({type:'arm',tabId:7});await h.flush();assert.ok(entered);
  await h.command({type:'stop'});release();await h.flush();
  assert.equal(h.state.phase,'idle');assert.equal(h.logs.submits.length,0);assert.equal(h.logs.mutations.length,0);
});
test('pending drops anywhere block starting without unscheduling a registered course',async()=>{
  const h=harness({rows:[row('30390','CSCI-580',false,true)]});
  assert.match((await h.command({type:'arm',tabId:7})).error,/pending drop/i);assert.equal(h.logs.mutations.length,0);
});
test('fresh checkout contamination never reaches Submit',async()=>{
  const h=harness({contentHook:async(message,{checkout})=>{
    if(message.type==='read-checkout'){const s=checkout();s.rows.push({...row('11111','EE-450'),grade:'Letter Grade',seatText:'10 of 20'});return s;}
  }});await h.command({type:'arm',tabId:7});await h.flush();
  assert.equal(h.logs.submits.length,0);assert.equal(h.state.journal,null);assert.equal(h.rows.find(r=>r.section==='32406').scheduled,true);
});
test('initial HTTP429 cooldown persists across Stop and another Start',async()=>{
  let requests=0;
  const h=harness({fetcher:async()=>{requests++;return {ok:false,status:429,headers:{get:()=> '180'},body:{cancel:async()=>{}}};}});
  await h.command({type:'arm',tabId:7});await h.flush();assert.equal(requests,1);
  await h.command({type:'stop'});await h.command({type:'arm',tabId:7});await h.flush();assert.equal(requests,1);assert.ok(h.storage.apiCooldownUntil>Date.now());
});
test('interrupted durable attempt starts paused and is never replayed after worker restart',async()=>{
  const cfg=config();const old={schema:2,config:cfg,run:'old',tabId:7,phase:'submitted',activeTarget:cfg.targets[0].id,
    results:{},targetStates:{},attempt:{id:'old-attempt',targetId:cfg.targets[0].id,submittedAt:Date.now()},journal:{removed:[{section:'32406',course:'DSCI-556'}],added:[]}};
  const h=harness({storage:{state:old}});await h.flush();h.emit('alarm',{name:'seat-check'});await h.flush();
  assert.equal(h.state.phase,'paused');assert.equal(h.logs.submits.length,0);assert.ok(h.state.attempt);assert.ok(h.state.journal);
});
test('manual reviewed-result recovery restores selections without submitting',async()=>{
  const h=harness({confirm:false});await h.command({type:'arm',tabId:7});await h.flush();
  h.advance(46000);h.emit('alarm',{name:'seat-check'});await h.flush();
  const count=h.logs.submits.length;await h.command({type:'acknowledge-review',tabId:7});await h.flush();
  assert.equal(h.state.phase,'idle');assert.equal(h.state.journal,null);assert.equal(h.state.attempt,null);assert.equal(h.logs.submits.length,count);assert.equal(h.rows.find(r=>r.section==='32406').scheduled,true);
});
test('non-CSCI linked sections remain one all-or-nothing checkout bundle',async()=>{
  const cfg=G.normalizeConfig({term:'20271',targets:[{course:'CHEM-105A',sections:[{id:'17100',units:'4'},{id:'17101',units:'0'}],grade:'L'}]});
  const lecture=row('17100','CHEM-105A',false),lab={...row('17101','CHEM-105A',false),units:'0',grade:'N/A'};
  const h=harness({config:cfg,rows:[lecture,lab],bothOpen:true});await h.command({type:'arm',tabId:7});await h.flush();
  assert.deepEqual(h.logs.submits.map(s=>s.ids),[['17100','17101']]);assert.equal(h.state.phase,'complete');
});
test('editing a watchlist during a transaction is rejected',async()=>{
  const h=harness({confirm:false});await h.command({type:'arm',tabId:7});await h.flush();
  assert.match((await h.command({type:'save-config',config:{term:'20273',targets:[]}})).error,/recovery/);assert.equal(h.storage.config.term,'20271');
});
test('a seat lost before Submit restores other courses once and waits for a fresh opening',async()=>{
  let openA=true;
  const h=harness({open:course=>course==='CSCI-587'&&openA,contentHook:async(message)=>{if(message.type==='read-checkout')openA=false;}});
  await h.command({type:'arm',tabId:7});await h.flush(250);
  assert.equal(h.logs.submits.length,0);assert.equal(h.state.phase,'watching');assert.equal(h.state.results[config().targets[0].id].open,false);
  assert.deepEqual(h.logs.mutations.map(op=>[op.kind,op.section]),[['unschedule','32406'],['schedule','32406']]);
});
test('Stop after isolation but before Submit restores known original selections',async()=>{
  let entered=false,release;const pending=new Promise(resolve=>release=resolve);
  const h=harness({contentHook:async(message)=>{if(message.type==='read-checkout'){entered=true;await pending;}}});
  await h.command({type:'arm',tabId:7});await h.flush();assert.ok(entered);assert.equal(h.rows.find(r=>r.section==='32406').scheduled,false);
  await h.command({type:'stop'});release();await h.flush();
  assert.equal(h.state.phase,'idle');assert.equal(h.state.journal,null);assert.equal(h.logs.submits.length,0);assert.equal(h.rows.find(r=>r.section==='32406').scheduled,true);
});
test('one closed linked component prevents any cart isolation or partial checkout',async()=>{
  const cfg=G.normalizeConfig({term:'20271',targets:[{course:'CHEM-105A',sections:[{id:'17100',units:'4'},{id:'17101',units:'0'}],grade:'L'}]});
  const h=harness({config:cfg,rows:[],fetcher:async()=>({ok:true,json:async()=>({termCode:'20271',scheduledCourseCode:{courseHyphen:'CHEM-105A'},sections:[
    {sisSectionId:'17100',termCode:20271,totalSeats:75,registeredSeats:74,isFull:false,isCancelled:false},
    {sisSectionId:'17101',termCode:20271,totalSeats:20,registeredSeats:20,isFull:true,isCancelled:false}]})})});
  await h.command({type:'arm',tabId:7});await h.flush();assert.equal(h.state.phase,'watching');assert.equal(h.logs.submits.length,0);assert.equal(h.logs.mutations.length,0);
});
test('all already registered targets finish without any public lookup or mutation',async()=>{
  const h=harness({rows:[row('30306','CSCI-587',true,true),row('32406','DSCI-556',true,true)]});
  await h.command({type:'arm',tabId:7});await h.flush();assert.equal(h.state.phase,'complete');assert.equal(h.logs.lookups.length,0);assert.equal(h.logs.mutations.length,0);assert.equal(h.logs.submits.length,0);
});
test('a single-course API response is shared by targets of that course in a sweep',async()=>{
  const cfg=G.normalizeConfig({term:'20271',targets:[{course:'DSCI-556',sections:[{id:'32406',units:'4'}]},{course:'DSCI-556',sections:[{id:'32407',units:'4'}]}]});
  const h=harness({config:cfg,rows:[]});await h.command({type:'arm',tabId:7});await h.flush();assert.deepEqual(h.logs.lookups,['DSCI-556']);
});
test('course search matches code and title with one cached catalog request across queries',async()=>{
  const h=harness();const first=await h.command({type:'search-courses',term:'20271',query:'geospatial'});
  assert.equal(first.courses[0].code,'CSCI-587');const second=await h.command({type:'search-courses',term:'20271',query:'DSCI'});
  assert.equal(second.courses[0].code,'DSCI-556');assert.equal(h.logs.lookups.length,1);assert.equal(h.logs.mutations.length,0);
});
test('short search input does not fetch USC catalog and invalid terms fail before networking',async()=>{
  const h=harness();assert.equal((await h.command({type:'search-courses',term:'20271',query:'c'})).total,0);
  assert.ok((await h.command({type:'search-courses',term:'bad',query:'CSCI'})).error);assert.equal(h.logs.lookups.length,0);
});
test('normalized course list cache survives worker restart in Chrome session storage',async()=>{
  const sessionStore={};const a=harness({session:true,sessionStore});await a.command({type:'search-courses',term:'20271',query:'CSCI'});assert.equal(a.logs.lookups.length,1);
  sessionStore.catalogCache['20271'].loadedAt-=7*60*60*1000;
  const b=harness({session:true,sessionStore});const result=await b.command({type:'search-courses',term:'20271',query:'DSCI'});assert.equal(result.courses[0].code,'DSCI-556');assert.equal(b.logs.lookups.length,0);
  b.advance(2*60*60*1000);await b.command({type:'search-courses',term:'20271',query:'CSCI'});assert.equal(b.logs.lookups.length,1);
});
test('course picker details are tied to the selected semester and course',async()=>{
  const h=harness();const result=await h.command({type:'course-sections',term:'20271',course:'CSCI 587'});
  assert.equal(result.code,'CSCI-587');assert.equal(result.term,'20271');assert.equal(result.sections[0].id,'30306');assert.equal(result.sections[0].units[0],'4');
  assert.equal(h.logs.mutations.length,0);assert.equal(h.logs.submits.length,0);
});

test('saved active state without popup permission stays silent on laptop startup',async()=>{
  const old={schema:2,config:config(),run:'old',tabId:7,phase:'watching',results:{},targetStates:{}};
  const h=harness({storage:{state:old}});
  h.emit('alarm',{name:'seat-check'});h.emit('removed',7);h.emit('updated',7,{status:'complete'});
  await h.flush();
  assert.equal(h.state.phase,'idle');assert.equal(h.logs.notifications.length,0);
  assert.equal(h.logs.lookups.length,0);assert.equal(h.logs.submits.length,0);
});

test('a fresh installation starts empty and requires a chosen course before enabling',async()=>{
  const h=harness({storage:{config:undefined}});await h.flush();
  assert.equal(h.state.phase,'idle');assert.deepEqual(h.storage.config.targets,[]);
  assert.match((await h.command({type:'arm',tabId:7})).error,/one to twelve/);
  assert.equal(h.logs.lookups.length,0);assert.equal(h.logs.submits.length,0);
  assert.equal(h.logs.notifications.length,0);
});

test('startup and extension update revoke an old session permission before background events',async()=>{
  for(const event of ['startup','installed']){
    const old={schema:2,config:config(),run:'old',tabId:7,phase:'watching',results:{},targetStates:{}};
    const h=harness({storage:{state:old},sessionStore:{enabledRun:'old'}});
    h.emit(event);h.emit('removed',7);h.emit('alarm',{name:'seat-check'});
    await h.flush();
    assert.equal(h.state.phase,'idle');assert.equal(h.sessionStorage.enabledRun,null);
    assert.equal(h.logs.notifications.length,0);assert.equal(h.logs.submits.length,0);
  }
});

test('an enabled watch can notify, but Stop silences subsequent tab and alarm events',async()=>{
  const h=harness({open:()=>false});await h.command({type:'arm',tabId:7});await h.flush();
  assert.equal(h.sessionStorage.enabledRun,h.state.run);
  h.emit('removed',7);await h.flush();assert.equal(h.logs.notifications.length,1);
  await h.command({type:'arm',tabId:7});await h.flush();
  await h.command({type:'stop'});h.emit('removed',7);h.emit('alarm',{name:'seat-check'});await h.flush();
  assert.equal(h.logs.notifications.length,1);assert.equal(h.sessionStorage.enabledRun,null);
});

test('ordinary worker suspension preserves a popup-enabled watch within the same Chrome session',async()=>{
  const a=harness({open:()=>false});await a.command({type:'arm',tabId:7});await a.flush();
  const b=harness({open:()=>false,storage:{state:a.state},sessionStore:a.sessionStorage});await b.flush();
  assert.equal(b.state.phase,'watching');
  b.emit('removed',7);await b.flush();assert.equal(b.logs.notifications.length,1);
});

test('Stop during a pending mutation also suppresses later recovery notifications',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);
  const h=harness({beforeMutation:async()=>pending});await h.command({type:'arm',tabId:7});await h.flush();
  await h.command({type:'stop'});release();await h.flush();h.emit('removed',7);await h.flush();
  assert.equal(h.logs.notifications.length,0);assert.equal(h.sessionStorage.enabledRun,null);
});
