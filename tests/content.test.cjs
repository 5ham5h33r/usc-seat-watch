const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { DOMParser } = require('linkedom');
const G = require('../extension/guard.js');
const D = require('../extension/dom.js');
const config=G.normalizeConfig({term:'20271',targets:[{course:'CHEM-105A',sections:[{id:'17100',units:'4'}],grade:'L'}]});
const base=()=>({section:'17100',course:'CHEM-105a',units:'4.0',grade:'L',scheduled:true,registered:false});
const field=(name,value)=>'<span class="section_row"><span class="table-headers-xsmall">'+name+': </span>'+value+'</span>';
const header='<a id="activeTermTab">Spring 2027 Classes</a>';
function binHTML(rows){return header+rows.map(row=>'<div id="courseBin_'+row.course+'"><div class="section" id="section_'+row.section+'"><div class="section_crsbin">'+
  field('Action',['NN','YN','YY','NY'].map(flags=>'<div class="actionbar" id="sched'+flags[0]+'_reg'+flags[1]+'_'+row.section+'" style="display:'+(flags===(row.scheduled?'Y':'N')+(row.registered?'Y':'N')?'block':'none')+'">'+
  '<a data-ajax-method="Post" data-ajax-url="/api/Section/20271/'+row.section+'/'+(row.scheduled?'un-schedule':'schedule')+'">'+(row.scheduled?'Unschedule':'Schedule')+'</a></div>').join(''))+
  field('Section',row.section+' R')+field('Units',row.units)+field('Grade Option',row.registered?'Letter Grade':'<select name="GradeOptionCode"><option selected value="'+row.grade+'">Letter Grade</option></select>')+
  '</div></div></div>').join('');}
function checkoutHTML(rows){const groups=[...new Set(rows.map(row=>row.course))];return header+
  '<h5 class="RegAdDrpTitl">You are about to REGISTER for the following sections:</h5><form id="MainForm" method="post" action="/CheckoutResponse"><input type="button" id="SubmitButton" value="Submit"></form>'+
  groups.map(course=>'<div id="courseBin_'+course+'">'+rows.filter(row=>row.course===course).map(row=>'<div class="section" id="section_'+row.section+'"><div class="section_crsbin">'+field('Section',row.section)+field('Units',row.units)+field('Registered','74 of 75')+field('Grade Option','Letter Grade')+'</div></div>').join('')+'</div>').join('');}
function parse(html){const doc=new DOMParser().parseFromString('<html><body>'+html+'</body></html>','text/html');for(const form of doc.querySelectorAll('form'))Object.defineProperty(form,'method',{value:form.getAttribute('method')||'get'});const button=doc.getElementById('SubmitButton');if(button){Object.defineProperty(button,'form',{value:doc.getElementById('MainForm')});button.getClientRects=()=>[{}];}return doc;}
function harness({kind='unschedule',phase='preparing',targetRows=[base()],liveRows,extraFresh=false,cancelOnRead=false,registered=false}={}){
  let rows=structuredClone(targetRows),clicks=0,listener;
  if(registered)rows[0].registered=true;
  const op={id:'op',kind,section:'17100',course:'CHEM-105A'};
  const state={phase,run:'run',tabId:7,config,activeTarget:config.targets[0].id,pendingMutation:op,
    attempt:{id:'attempt',targetId:config.targets[0].id},journal:{removed:[],added:[]}};
  let html;
  if(phase==='submitted')html=checkoutHTML(liveRows||rows);
  else if(kind==='add')html=header+'<div id="courseBin_CHEM-105a"><div class="section" id="section_17100"><form method="post" data-ajax-url="/api/section/20271/17100/add"><button id="submit-add-17100">Add to myCourseBin</button></form></div></div>';
  else html=binHTML(liveRows||rows);
  const doc=parse(html);
  doc.querySelectorAll('a[data-ajax-url],button,#SubmitButton').forEach(element=>element.addEventListener('click',event=>{
    event.preventDefault();clicks++;
    if(phase==='submitted')rows[0].registered=true;
    else if(kind==='add')rows=[{...base(),scheduled:false}];
    else rows[0].scheduled=kind==='schedule';
  }));
  const location={pathname:phase==='submitted'?'/Checkout':kind==='add'?'/Courses':'/CourseBin',href:kind==='add'?'https://webreg.usc.edu/Courses?Course=CHEM-105A':'https://webreg.usc.edu/CourseBin'};
  const chrome={runtime:{id:'test',onMessage:{addListener:fn=>listener=fn}},storage:{local:{get:async()=>({state:structuredClone(state)})}}};
  class Parser{parseFromString(html){return parse(html);}}
  const context=vm.createContext({document:doc,location,chrome,URL,AbortSignal,console,DOMParser:Parser,structuredClone,setTimeout,
    fetch:async path=>{
      if(cancelOnRead)state.phase='paused';
      const fresh=extraFresh?[...rows,{...base(),course:'DSCI-556',section:'32406'}]:rows;
      return {ok:true,status:200,type:'basic',text:async()=>path==='/CourseBin'?binHTML(rows):checkoutHTML(fresh)};
    }});
  for(const file of ['guard.js','dom.js','content.js'])vm.runInContext(fs.readFileSync('extension/'+file,'utf8'),context);
  const command=message=>new Promise(resolve=>listener({run:'run',tabId:7,...message},{id:'test'},resolve));
  return {command,state,doc,get clicks(){return clicks;},get rows(){return rows;}};
}
test('DOM parser reads labeled cells and normalizes non-CSCI suffix case',()=>{
  const parsed=D.bin(parse(binHTML([base()])));G.assertBin(parsed,'20271');
  assert.equal(parsed.rows[0].course,'CHEM-105A');assert.equal(parsed.rows[0].units,'4.0');assert.equal(parsed.rows[0].grade,'L');
});
test('DOM parser rejects multiple active action bars',()=>{
  const doc=parse(binHTML([base()]));doc.querySelector('#schedN_regN_17100').style.display='block';assert.throws(()=>D.bin(doc),/ambiguous/);
});
test('real content unschedules one journaled unregistered section and verifies server state',async()=>{
  const h=harness();const response=await h.command({type:'mutate',operationId:'op'});
  assert.equal(response.confirmed,true);assert.equal(h.clicks,1);assert.equal(h.rows[0].scheduled,false);
});
test('content Schedule and Add use only the exact configured term/section endpoints',async()=>{
  const schedule=harness({kind:'schedule',targetRows:[{...base(),scheduled:false}]});assert.equal((await schedule.command({type:'mutate',operationId:'op'})).confirmed,true);assert.equal(schedule.clicks,1);
  const add=harness({kind:'add',targetRows:[]});assert.equal((await add.command({type:'mutate',operationId:'op'})).confirmed,true);assert.equal(add.clicks,1);
});
test('content refuses to unschedule a registered section',async()=>{
  const h=harness({registered:true});assert.match((await h.command({type:'mutate',operationId:'op'})).error,/Registered/);assert.equal(h.clicks,0);
});
test('content refuses missing durable mutation claims and cancellation during server reads',async()=>{
  const absent=harness();assert.match((await absent.command({type:'mutate',operationId:'wrong'})).error,/claim/);assert.equal(absent.clicks,0);
  const stopped=harness({cancelOnRead:true});assert.match((await stopped.command({type:'mutate',operationId:'op'})).error,/cancelled/);assert.equal(stopped.clicks,0);
});
test('a stale live Course Bin is reloaded rather than clicking the wrong action',async()=>{
  const h=harness({liveRows:[{...base(),scheduled:false}]});const response=await h.command({type:'mutate',operationId:'op'});assert.equal(response.stale,true);assert.equal(h.clicks,0);
});
test('real content submits only a matching live and freshly fetched isolated checkout',async()=>{
  const h=harness({phase:'submitted'});const response=await h.command({type:'submit',attemptId:'attempt'});assert.equal(response.clicked,true);assert.equal(h.clicks,1);
});
test('closed class contamination in fresh server checkout blocks a stale live Submit',async()=>{
  const h=harness({phase:'submitted',extraFresh:true});const response=await h.command({type:'submit',attemptId:'attempt'});assert.ok(response.error);assert.equal(response.notSubmitted,true);assert.equal(h.clicks,0);
});
test('a cancelled durable submission is never clicked',async()=>{
  const h=harness({phase:'submitted',cancelOnRead:true});const response=await h.command({type:'submit',attemptId:'attempt'});assert.match(response.error,/cancelled/);assert.equal(response.notSubmitted,true);assert.equal(h.clicks,0);
});
