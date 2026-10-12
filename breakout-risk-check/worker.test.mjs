import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('./worker.js',import.meta.url),'utf8');
const worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
const stored=new Map();
const env={HOOK_TOKEN:'hook-test',READ_TOKEN:'read-test',ALLOCATION_CAP_EUR:'800',ALERTS:{
  put:async(k,v)=>{await new Promise(resolve=>setImmediate(resolve));stored.set(k,v)},
  get:async k=>stored.get(k)||null,
  list:async({prefix,limit})=>({keys:[...stored.keys()].filter(k=>k.startsWith(prefix)).sort().slice(0,limit).map(name=>({name}))})
}};
const req=(path,options)=>new Request('https://test.invalid'+path,options);
const get=path=>worker.fetch(req(path),env);
assert.equal((await get('/api/alerts')).status,401);
assert.deepEqual((await (await get('/api/alerts?token=read-test')).json()).alerts,[]);
stored.set('latest',JSON.stringify({ticker:'OLD',exchange:'NYSE',triggeredAt:'2020-01-01T00:00:00Z'}));
const legacy=(await (await get('/api/alerts?token=read-test')).json()).alerts[0];
assert.ok(legacy.id.startsWith('alert:'));
assert.equal((await get('/api/latest?token=read-test&id=other')).status,400);
assert.equal((await worker.fetch(req('/hook?token=hook-test',{method:'POST',body:'null'}),env)).status,400);
await Promise.all(Array.from({length:7},(_,i)=>worker.fetch(req('/hook?token=hook-test',{method:'POST',body:JSON.stringify({ticker:'T'+i,exchange:'NYSE'})}),env)));
const history=[...stored.keys()].filter(k=>k.startsWith('alert:'));
assert.equal(history.length,8,'Concurrent writes must retain every alert and the legacy alert');
const alerts=(await (await get('/api/alerts?token=read-test')).json()).alerts;
assert.equal(alerts.length,5);
assert.equal(new Set(alerts.map(a=>a.id)).size,5);
assert.deepEqual(alerts.map(a=>a.id),history.sort().slice(0,5));
globalThis.fetch=async()=>Response.json({rates:{USD:1.1},date:'2026-10-12'});
const selected=(await (await get('/api/latest?token=read-test&id='+alerts[4].id)).json());
assert.equal(selected.alert.id,alerts[4].id);
assert.equal(selected.allocationCapEUR,800);
assert.equal((await (await get('/api/latest?token=read-test&id='+legacy.id)).json()).alert.ticker,'OLD');

// Run the page script with controlled requests to test selection and request order.
const elements=new Map();
const element=id=>{
  if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:false,options:[],addEventListener(){},replaceChildren(){this.options=[];this.value=''},append(option){this.options.push(option);if(this.options.length===1)this.value=option.value}});
  return elements.get(id);
};
const pending=[];
const context=vm.createContext({document:{getElementById:element,createElement:()=>({})},location:{search:'?token=read-test'},URLSearchParams,Intl,Date,fetch:async url=>{
  if(url.startsWith('/api/alerts'))return Response.json({alerts});
  return new Promise(resolve=>pending.push({url,resolve}));
}});
vm.runInContext(source.match(/<script>([\s\S]*?)<\/script>/)[1],context);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
await flush();
assert.equal(element('alerts').options.length,5);
assert.equal(element('alerts').value,alerts[0].id);
element('entry').value='8.50';
element('alerts').value=alerts[4].id;
element('alerts').onchange();
assert.equal(element('entry').value,'');
assert.equal(element('qty').textContent,'—');
await flush();
const result=alert=>({alert,weeklyLowUSD:8,usdPerEur:1.1,stopBufferPct:1,allocationCapEUR:800});
pending[1].resolve(Response.json(result(alerts[4])));
await flush();
pending[0].resolve(Response.json(result(alerts[0])));
await flush();
assert.equal(element('ticker').textContent,'NYSE:'+alerts[4].ticker,'Old response must not replace selected alert');
console.log('Passed: access control, migration, five-alert limit, concurrent writes, selected alert, entry reset, and response order.');
