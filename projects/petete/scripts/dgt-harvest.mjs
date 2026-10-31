#!/usr/bin/env node
// Requires Node >=22 with --experimental-transform-types. No API keys required.
import {DgtClient} from '../worker/dgt.ts';
import {mkdir,readFile,writeFile,rename,appendFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{help:{type:'boolean'},from:{type:'string',default:'1997-01-01'},to:{type:'string',default:new Date().toISOString().slice(0,10)},output:{type:'string',default:'data/harvest/rulings.jsonl'},state:{type:'string'},'max-documents':{type:'string',default:'1000'},'interval-ms':{type:'string',default:'1200'}}});
if(values.help){process.stdout.write('Usage: node --experimental-transform-types scripts/dgt-harvest.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--output data/harvest/rulings.jsonl] [--state checkpoint.json] [--max-documents 1000] [--interval-ms 1200]\nResume with exactly the same range and output arguments. Fetches official DGT serially, checkpoints each document, never guesses ruling IDs.\n');process.exit(0);}
const output=resolve(values.output),statePath=resolve(values.state||output+'.state.json');
const from=values.from,to=values.to;
for(const date of [from,to])if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error('Invalid ISO date.');
if(from<'1997-01-01'||to<from||to>new Date().toISOString().slice(0,10))throw new Error('Date range must be 1997 through today.');
const max=Number(values['max-documents']),interval=Number(values['interval-ms']);
if(!Number.isInteger(max)||max<1||!Number.isFinite(interval)||interval<1000)throw new Error('Use a positive max-documents and interval-ms of at least 1000.');
const windows=[];
for(let cursor=from;cursor<=to;){const d=new Date(cursor+'T00:00:00Z');const end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).toISOString().slice(0,10);for(const tab of [1,2])windows.push({from:cursor,to:end<to?end:to,tab});cursor=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)).toISOString().slice(0,10);}
await mkdir(dirname(output),{recursive:true});await mkdir(dirname(statePath),{recursive:true});
let state={from,to,output,window:0,page:1,nextDocument:0,processed:0,uniqueReferences:[],reconciliationPass:0};
try{state=JSON.parse(await readFile(statePath,'utf8'));if(state.from!==from||state.to!==to||state.output!==output)throw new Error('Checkpoint arguments differ; use a new output/state path.');}catch(error){if(error.code!=='ENOENT')throw error;}
const checkpoint=async()=>{await writeFile(statePath+'.tmp',JSON.stringify({...state,updatedAt:new Date().toISOString()},null,2));await rename(statePath+'.tmp',statePath);};
const client=new DgtClient(fetch,interval);let count=0;
try{
 while(state.window<windows.length&&count<max){
  const window=windows[state.window];const page=await client.search(window.from,window.to,window.tab,state.page,state.query,state.order);
  state.query=page.query;state.order=page.order;state.lastSourceTotal=page.total;
  if(page.total===0){if(state.uniqueReferences.length)throw new Error('Source changed to zero during an active window; manual reconciliation required.');state.window++;state.page=1;state.nextDocument=0;state.query=undefined;state.order=undefined;await checkpoint();continue;}
  while(state.nextDocument<page.documentIds.length&&count<max){
   const document=await client.document(page.documentIds[state.nextDocument],window.tab,page.query);
   if(document.date<window.from||document.date>window.to)throw new Error('Source returned a document outside requested date window.');
   await appendFile(output,JSON.stringify(document)+'\n');
   state.nextDocument++;state.processed++;count++;if(!state.uniqueReferences.includes(document.reference))state.uniqueReferences.push(document.reference);await checkpoint();
   process.stdout.write(JSON.stringify({reference:document.reference,date:document.date,processed:state.processed,window:state.window+1,windows:windows.length})+'\n');
  }
  if(state.nextDocument>=page.documentIds.length){
   if(state.page<page.totalPages){state.page++;state.nextDocument=0;}
   else if(state.uniqueReferences.length!==page.total){
    if(state.reconciliationPass>=2)throw new Error(`Window reconciliation failed: ${state.uniqueReferences.length} unique documents, source ${page.total}.`);
    state.reconciliationPass++;state.page=1;state.nextDocument=0;
   }else{state.window++;state.page=1;state.nextDocument=0;state.query=undefined;state.order=undefined;state.uniqueReferences=[];state.reconciliationPass=0;}
  }
  await checkpoint();
 }
 state.status=state.window>=windows.length?'completed':'paused';delete state.error;await checkpoint();
 process.stdout.write(JSON.stringify({status:state.status,processedThisRun:count,processedTotal:state.processed,output,state:statePath,note:'Only completed and reconciled windows count as collected. Duplicate JSONL lines from interrupted writes are safe to import idempotently.'})+'\n');
}catch(error){state.status='failed';state.error=String(error);await checkpoint();throw error;}
