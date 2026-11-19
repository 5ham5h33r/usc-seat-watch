const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const guard = require('../extension/guard.js');
const term = '20271';
const config = targets => guard.normalizeConfig({ term, targets });
const target = (course='MATH-225', ids=['40001'], grade='L') => config([{ course, grade, sections:ids.map((id,index)=>({id,units:index===0?'4.0':0})) }]).targets[0];
const row = (section='40001', course='MATH-225', changes={}) => ({ section,course,scheduled:true,registered:false,units:'4.0',grade:'L',...changes });
const bin = rows => ({ term:guard.termLabel(term), rows });
const checkout = (watch=target()) => ({ path:'/Checkout',term:guard.termLabel(term),headings:['You are about to REGISTER for the following sections:'],courses:[watch.course],rows:watch.sections.map(section=>({section:section.id,course:watch.course,units:section.units,grade:Number(section.units)===0?'N/A':{L:'Letter Grade',PN:'Pass/No Pass',V:'Audit'}[watch.grade],seatText:'74 of 75'})),submit:true,action:'/CheckoutResponse',method:'post' });
const api = (watch=target()) => ({ termCode:Number(term),scheduledCourseCode:{courseHyphen:watch.course},sections:watch.sections.map(section=>({sisSectionId:section.id,termCode:Number(term),isCancelled:false,isFull:false,registeredSeats:74,totalSeats:75})) });

test('course codes normalize across departments and preserve course suffix identity',()=>{
  for(const [input,expected] of [['math 225','MATH-225'],['BUAD304','BUAD-304'],['gesm-120g','GESM-120G'],['PHYS 153L','PHYS-153L'],['ABCDEFGH-1234AB','ABCDEFGH-1234AB']]) assert.equal(guard.normalizeCourse(input),expected);
  for(const input of ['C-123','ABCDEFGHI-123','CSCI-58','CSCI-12345','MATH-225/226','CSCI--587',null,undefined]) assert.throws(()=>guard.normalizeCourse(input));
});
test('term labels are explicit and validate semester codes',()=>{
  assert.equal(guard.termLabel('20271'),'Spring 2027 Classes');assert.equal(guard.termLabel(20272),'Summer 2027 Classes');assert.equal(guard.termLabel('20273'),'Fall 2027 Classes');
  for(const value of ['',null,'20274','2027','0271']) assert.throws(()=>guard.termLabel(value));
});
test('configuration generates deterministic identities and canonical numeric units',()=>{
  const result=config([{course:'phys 153l',sections:[{id:40001,units:'4.00'},{id:'40002',units:0}]}]);
  assert.deepEqual(result,{term,targets:[{id:'PHYS-153L:40001,40002',course:'PHYS-153L',sections:[{id:'40001',units:'4'},{id:'40002',units:'0'}],grade:'L'}]});
  assert.deepEqual(config([{course:'MATH225',grade:'pn',sections:[{id:'40003',units:'.5'}]}]).targets[0].sections,[{id:'40003',units:'0.5'}]);
});
test('configuration bounds and duplicate section identities are enforced across targets',()=>{
  assert.throws(()=>config([]));assert.throws(()=>config(Array(13).fill({})));
  assert.throws(()=>config([{course:'MATH225',sections:[]}]));
  assert.throws(()=>config([{course:'MATH225',sections:Array.from({length:7},(_,i)=>({id:String(40000+i),units:0}))}]));
  assert.throws(()=>config([{course:'MATH225',sections:[{id:'40001',units:4},{id:'40001',units:4}]}]));
  assert.throws(()=>config([{course:'MATH225',sections:[{id:'40001',units:4}]},{course:'PHYS153',sections:[{id:'40001',units:4}]}]));
  for(const units of ['',null,undefined,' ',true,NaN,Infinity,-1,21,'0x10','4e0']) assert.throws(()=>config([{course:'MATH225',sections:[{id:'40001',units}]}]));
  for(const grade of ['',null,'A']) assert.throws(()=>config([{course:'MATH225',grade,sections:[{id:'40001',units:4}]}]));
});
test('availability requires all linked section components to have seats',()=>{
  const watch=target('PHYS-153L',['40001','40002']);const data=api(watch);
  assert.equal(guard.availability(data,watch,term).open,true);
  data.sections[1].isFull=true;data.sections[1].registeredSeats=75;
  const closed=guard.availability(data,watch,term);assert.equal(closed.open,false);assert.equal(closed.sections[0].open,true);assert.equal(closed.sections[1].open,false);assert.equal(closed.id,watch.id);
});
test('availability rejects mismatched or incomplete data and closes cancelled or overenrolled sections',()=>{
  const watch=target();
  for(const edit of [data=>data.termCode=20273,data=>data.scheduledCourseCode.courseHyphen='MATH-226',data=>data.sections=[],data=>data.sections.push({...data.sections[0]}),data=>data.sections[0].termCode=20273,data=>data.sections[0].registeredSeats='74',data=>data.sections[0].totalSeats=0,data=>delete data.sections[0].isFull,data=>data.sections[0].registeredSeats=-1]){const data=api();edit(data);assert.throws(()=>guard.availability(data,watch,term));}
  for(const edit of [data=>data.sections[0].isCancelled=true,data=>data.sections[0].registeredSeats=76]){const data=api();edit(data);assert.equal(guard.availability(data,watch,term).open,false);}
});
test('checkout accepts exactly the target bundle and normalizes numeric unit representation',()=>{
  const watch=target('PHYS-153L',['40001','40002']);const snapshot=checkout(watch);snapshot.rows[0].units='4.000';
  assert.equal(guard.validateCheckout(snapshot,watch,term,true),null);
  snapshot.rows.reverse();assert.equal(guard.validateCheckout(snapshot,watch,term,true),null);
});
test('checkout rejects other scheduled courses, drops, partial bundles and options changes',()=>{
  const watch=target();
  for(const edit of [s=>s.path='/CourseBin',s=>s.term='Fall 2027 Classes',s=>s.headings.push('You are about to DROP'),s=>s.courses.push('BUAD-304'),s=>s.rows.push({...s.rows[0],section:'40002'}),s=>s.rows[0].course='MATH-226',s=>s.rows[0].section='40002',s=>s.rows[0].units=3,s=>s.rows[0].grade='Audit',s=>s.submit=false,s=>s.action='/Unexpected',s=>s.method='get',s=>s.rows=[]]){const s=checkout();edit(s);assert.ok(guard.validateCheckout(s,watch,term,true));}
  const linked=target('PHYS-153L',['40001','40002']);const duplicate=checkout(linked);duplicate.rows[1]={...duplicate.rows[0]};assert.ok(guard.validateCheckout(duplicate,linked,term));
});
test('checkout fails closed on closed, full, zero capacity or unrecognized status',()=>{
  const watch=target();
  for(const seatText of ['Closed','75 of 75','76 / 75','0/0','Unknown','Seats available']){const s=checkout();s.rows[0].seatText=seatText;assert.ok(guard.validateCheckout(s,watch,term,true));}
  for(const seatText of ['Open','74 of 75','74/75']){const s=checkout();s.rows[0].seatText=seatText;assert.equal(guard.validateCheckout(s,watch,term,true),null);}
  const s=checkout();s.rows[0].seatText='Closed';assert.equal(guard.validateCheckout(s,watch,term),null);assert.equal(guard.validateCheckout(s,watch,term,true),'closed');
});
test('grade options honor configured labels while zero-unit components may be ungraded',()=>{
  for(const grade of ['L','PN','V']){const watch=target('PHYS-153L',['40001','40002'],grade);for(const value of ['',null,'N/A']){const s=checkout(watch);s.rows[1].grade=value;assert.equal(guard.validateCheckout(s,watch,term),null);}const wrong=checkout(watch);wrong.rows[0].grade='N/A';assert.ok(guard.validateCheckout(wrong,watch,term));}
});
test('Course Bin requires the right term, unique identities and boolean status flags',()=>{
  assert.equal(guard.assertBin(bin([]),term).rows.length,0);
  for(const bad of [{term:'Fall 2027 Classes',rows:[]},bin([row(),row()]),bin([row('bad')]),bin([row('40001','MATH225',{scheduled:'true'})]),bin([row('40001','MATH225',{registered:undefined})]),{term:guard.termLabel(term)}]) assert.throws(()=>guard.assertBin(bad,term));
});
test('any pending drop blocks isolation even when the selected target is already registered',()=>{
  assert.throws(()=>guard.isolationPlan(bin([row('40001','MATH225',{registered:true}),row('50001','BUAD304',{registered:true,scheduled:false})]),target(),term),/pending drop/);
});
test('isolating open course A excludes closed B and unrelated scheduled sections without touching registrations',()=>{
  const watch=target();
  const plan=guard.isolationPlan(bin([row(),row('50001','BUAD304'),row('60001','PHYS153',{registered:true}),row('60002','PHYS153',{scheduled:false})]),watch,term);
  assert.deepEqual(plan,{unschedule:['50001'],schedule:[],missing:[],registered:false});
});
test('linked isolation distinguishes existing unscheduled components from missing components',()=>{
  const watch=target('PHYS-153L',['40001','40002','40003']);
  assert.deepEqual(guard.isolationPlan(bin([row('40001','PHYS153L',{scheduled:false}),row('40002','PHYS153L',{units:0,grade:null}),row('50001','BUAD304')]),watch,term),{unschedule:['50001'],schedule:['40001'],missing:['40003'],registered:false});
});
test('isolation never changes registered sections and refuses partial bundle registrations',()=>{
  const watch=target('PHYS153L',['40001','40002']);
  assert.throws(()=>guard.isolationPlan(bin([row('40001','PHYS153L',{registered:true}),row('40002','PHYS153L',{units:0,grade:'N/A'})]),watch,term),/part/);
  assert.throws(()=>guard.isolationPlan(bin([row('40001','PHYS153L',{registered:true})]),watch,term),/part/);
  assert.deepEqual(guard.isolationPlan(bin([row('40001','PHYS153L',{registered:true}),row('40002','PHYS153L',{registered:true,units:0,grade:'N/A'}),row('50001','BUAD304')]),watch,term),{unschedule:[],schedule:[],missing:[],registered:true});
});
test('fully registered targets are terminal when option fields are absent, but still require course identity',()=>{
  const watch=target('PHYS153L',['40001','40002']);
  const registered=bin([row('40001','PHYS153L',{registered:true,grade:undefined,units:undefined}),row('40002','PHYS153L',{registered:true,grade:'Change option',units:undefined}),row('50001','BUAD304')]);
  assert.deepEqual(guard.isolationPlan(registered,watch,term),{unschedule:[],schedule:[],missing:[],registered:true});
  registered.rows[1].course='PHYS154L';assert.throws(()=>guard.isolationPlan(registered,watch,term),/different course/);
  assert.throws(()=>guard.isolationPlan(bin([row('40001','MATH225',{grade:undefined})]),target(),term),/option changed/);
});
test('isolation checks every target row identity, units and grade before planning mutations',()=>{
  for(const changes of [{course:'MATH226'},{units:3},{grade:'PN'}]) assert.throws(()=>guard.isolationPlan(bin([row('40001','MATH225',changes),row('50001','BUAD304')]),target(),term));
});
test('restoration changes only journaled originals and skips registered sections',()=>{
  const journal={removed:[{section:'50001',course:'BUAD304'},{section:'60001',course:'PHYS153'}],added:[{section:'40001',course:'MATH225'},{section:'40002',course:'MATH225'}]};
  const current=bin([row('50001','BUAD304',{scheduled:false}),row('60001','PHYS153',{registered:true}),row('40001','MATH225'),row('40002','MATH225',{registered:true}),row('70001','WRIT150',{scheduled:false})]);
  assert.deepEqual(guard.restorePlan(current,journal,term),{schedule:['50001'],unschedule:['40001']});
});
test('restoration refuses missing, changed or duplicate identities and does not infer extra target components',()=>{
  const current=bin([row('40001','MATH225'),row('40002','MATH225'),row('50001','BUAD304',{scheduled:false})]);
  for(const journal of [{removed:[{section:'50002',course:'BUAD304'}],added:[]},{removed:[{section:'50001',course:'BUAD305'}],added:[]},{removed:[{section:'50001',course:'BUAD304'}],added:[{section:'50001',course:'BUAD304'}]},{added:[]}]) assert.throws(()=>guard.restorePlan(current,journal,term));
  assert.deepEqual(guard.restorePlan(current,{removed:[],added:[{section:'40001',course:'MATH225'}]},term),{schedule:[],unschedule:['40001']});
});
test('pre-add journal recovery skips only a still-absent target explicitly recorded as originally missing',()=>{
  const current=bin([row('50001','BUAD304',{scheduled:false})]);
  assert.deepEqual(guard.restorePlan(current,{removed:[{section:'50001',course:'BUAD304'}],added:[{section:'40001',course:'MATH225',wasMissing:true}]},term),{schedule:['50001'],unschedule:[]});
  for(const entry of [{section:'40001',course:'MATH225'},{section:'40001',course:'MATH225',wasMissing:false},{section:'40001',course:'MATH225',wasMissing:'true'}])
    assert.throws(()=>guard.restorePlan(current,{removed:[],added:[entry]},term),/missing/);
  assert.throws(()=>guard.restorePlan(current,{removed:[{section:'40001',course:'MATH225',wasMissing:true}],added:[]},term),/missing/);
  const added=bin([row('40001','MATH225')]);
  assert.deepEqual(guard.restorePlan(added,{removed:[],added:[{section:'40001',course:'MATH225',wasMissing:true}]},term),{schedule:[],unschedule:['40001']});
  assert.throws(()=>guard.restorePlan(added,{removed:[],added:[{section:'40001',course:'MATH226',wasMissing:true}]},term),/identity changed/);
});
test('Retry-After supports delta seconds, HTTP dates and invalid or expired input',()=>{
  assert.equal(guard.retryAfterMs('120'),120000);assert.equal(guard.retryAfterMs('0'),0);assert.equal(guard.retryAfterMs(null),0);assert.equal(guard.retryAfterMs('nonsense'),0);
  const now=Date.parse('Wed, 21 Oct 2015 07:27:00 GMT');assert.equal(guard.retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT',now),60000);assert.equal(guard.retryAfterMs('Wed, 21 Oct 2015 07:26:00 GMT',now),0);
});
test('guard is available in a classic browser context without CommonJS or DOM dependencies',()=>{
  const context=vm.createContext({});vm.runInContext(fs.readFileSync('extension/guard.js','utf8'),context);assert.equal(context.SeatGuard.normalizeCourse('BUAD304'),'BUAD-304');assert.equal(context.SeatGuard.normalizeConfig({term,targets:[{course:'BUAD304',sections:[{id:'50001',units:4}]}]}).targets[0].id,'BUAD-304:50001');
});
