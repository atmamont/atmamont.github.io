export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{"Content-Type":"application/json","Cache-Control":"no-store","Access-Control-Allow-Origin":"*"}});
    if (url.pathname === "/hook" && request.method === "POST") {
      if (!env.HOOK_TOKEN || url.searchParams.get("token") !== env.HOOK_TOKEN) return json({error:"Unauthorized"},401);
      let payload;
      try { payload=await request.json(); } catch { return json({error:"JSON expected"},400); }
      const symbol=String(payload.ticker||"").toUpperCase().trim();
      const exchange=String(payload.exchange||"").toUpperCase().trim();
      if (!/^[A-Z0-9._-]{1,20}$/.test(symbol) || !/^[A-Z0-9._-]{2,30}$/.test(exchange)) return json({error:"Invalid ticker/exchange"},400);
      const item={ticker:symbol,exchange,close:Number(payload.close)||null,triggeredAt:new Date().toISOString(),barTime:payload.time||null};
      await env.ALERTS.put("latest",JSON.stringify(item));
      return json({ok:true});
    }
    if (url.pathname === "/api/latest") {
      if (!env.READ_TOKEN || url.searchParams.get("token")!==env.READ_TOKEN) return json({error:"Unauthorized"},401);
      const raw=await env.ALERTS.get("latest");
      if (!raw) return json({error:"No TradingView alert received yet"},404);
      const alert=JSON.parse(raw);
      let weeklyLow=null,weeklyLabel=null,dataAsOf=null,dataError=null;
      let usdPerEur=null,fxAsOf=null,fxError=null;
      try {
        const fx=await fetch("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD");
        if(!fx.ok) throw Error("FX source unavailable");
        const f=await fx.json();
        usdPerEur=Number(f.rates?.USD); fxAsOf=f.date;
        if(!(usdPerEur>0)) throw Error("Invalid FX rate");
      } catch(e) { fxError=e.message; }
      try {
        if(!env.TWELVE_DATA_KEY) throw Error("TWELVE_DATA_KEY is not configured");
        const u=new URL("https://api.twelvedata.com/time_series");
        u.searchParams.set("symbol",alert.ticker);
        u.searchParams.set("interval","1day");
        u.searchParams.set("outputsize","35");
        u.searchParams.set("apikey",env.TWELVE_DATA_KEY);
        const resp=await fetch(u);
        if(!resp.ok) throw Error("Market data source unavailable");
        const obj=await resp.json();
        if(!Array.isArray(obj.values)||!obj.values.length) throw Error(obj.message||"Missing market data");
        // Previous COMPLETED calendar week, using exchange-local daily dates (US stocks).
        // Do not use the in-progress week, and do not silently fall back to an older week.
        const now=new Date();
        const newYorkDate=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
        const toMonday=s=>{const d=new Date(s+"T12:00:00Z");const day=d.getUTCDay();d.setUTCDate(d.getUTCDate()-((day+6)%7));return d.toISOString().slice(0,10);};
        const curMon=toMonday(newYorkDate), prev=new Date(curMon+"T12:00:00Z"); prev.setUTCDate(prev.getUTCDate()-7);
        weeklyLabel=prev.toISOString().slice(0,10);
        const bars=obj.values.filter(v=>toMonday(v.datetime)===weeklyLabel);
        if(!bars.length) throw Error("Previous completed week not available");
        weeklyLow=Math.min(...bars.map(v=>Number(v.low)));
        dataAsOf=obj.values[0].datetime;
        if(!(weeklyLow>0)) throw Error("Invalid weekly low");
      } catch(e) { dataError=e.message; }
      return json({alert,weeklyLowUSD:weeklyLow,weekStarting:weeklyLabel,dataAsOf,dataError,usdPerEur,fxAsOf,fxError,stopBufferPct:1,allocationCapEUR:Number(env.ALLOCATION_CAP_EUR)||1000});
    }
    if (url.pathname !== "/") return new Response("Not found",{status:404});
    return new Response(PAGE,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
  }
};
const PAGE = String.raw`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#111827"><title>Breakout Risk Check</title><style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#f3f4f6}body{margin:0;padding:22px 14px}main{max-width:460px;margin:auto}h1{font-size:23px;margin:0 0 10px}p,small{color:#aab7c9}section{background:#172235;border:1px solid #344054;border-radius:15px;padding:16px;margin:14px 0}.row{display:flex;justify-content:space-between;align-items:center;gap:10px}.big{font-size:25px;font-weight:750}.muted{color:#9aaabe}input{width:100%;box-sizing:border-box;background:#0c1728;color:white;border:1px solid #667085;padding:13px;border-radius:10px;font-size:20px}label{display:block;margin:0 0 9px;color:#c6d2e0}button{background:#334155;color:white;border:0;padding:12px 20px;border-radius:12px;font-size:17px;cursor:pointer}button:disabled{opacity:.5}.status{font-size:13px;color:#cbd5e1}.bad{color:#fca5a5}.good{color:#86efac}.metric{border-top:1px solid #344054;padding:12px 0}.hint{font-size:12px}a{color:#93c5fd}</style><main>
<h1>Breakout Risk Check</h1><p>TradingView alert → risk plan. No trade is placed.</p>
<section><div class="row"><strong id="ticker">Waiting for alert…</strong><span class="status" id="seen"></span></div><p class="status" id="state">Checking incoming alerts…</p><button id="refresh">Refresh alert</button></section>
<section><label for="entry">Planned entry price · EUR</label><input id="entry" type="number" min="0" step=".01" inputmode="decimal" placeholder="e.g. 7.92"><p class="hint">Enter the executable price from your EUR broker, not the USD chart price.</p></section>
<section><div class="row"><label>Maximum planned risk</label><strong class="big" id="risk">€100</strong></div><div class="row"><button id="minus">− €50</button><button id="plus">+ €50</button></div></section>
<section><div class="row"><span>Previous completed week's low</span><strong id="low">—</strong></div><div class="row metric"><span>Proposed stop (1% buffer)</span><strong id="stop">—</strong></div><div class="row metric"><span>FX reference, EUR/USD</span><strong id="fx">—</strong></div><p class="hint" id="fresh">Waiting for verified market and FX data.</p><p class="hint">The 1% buffer is an unvalidated research assumption. The previous week's low is not necessarily the base low. Converted EUR levels are indicative, not Trade Republic executable quotes.</p></section>
<section><div class="row metric"><span>Whole shares</span><strong class="big" id="qty">—</strong></div><div class="row metric"><span>Position cost</span><strong id="cost">—</strong></div><div class="row metric"><span>Planned loss</span><strong id="loss">—</strong></div><div class="row metric"><span>2R reference target</span><strong id="tp">—</strong></div><p class="hint" id="gate">Awaiting data and valid entry. No orders should be placed based on incomplete data.</p><p class="hint">Market stops can fill worse than their trigger. Not investment advice.</p></section></main><script>
let risk=100,data=null;
const $=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat("en-IE",{style:"currency",currency:"EUR"}).format(n);
function calc(){
 $("risk").textContent=money(risk);
 for(const x of ["qty","cost","loss","tp"])$(x).textContent="—";
 const e=Number($("entry").value),d=data;
 if(!d || d.dataError || d.fxError || !(d.weeklyLowUSD>0 && d.usdPerEur>0) || !(e>0)){ $("gate").textContent="Waiting for a verified weekly low, FX rate and EUR entry price.";return;}
 const stopUSD=d.weeklyLowUSD*(1-d.stopBufferPct/100), stopEUR=stopUSD/d.usdPerEur;
 $("stop").textContent=money(stopEUR)+" (indicative)";
 if(e<=stopEUR){$("gate").textContent="Entry must exceed the proposed stop. Check market data and broker quote.";return;}
 const q=Math.max(0,Math.min(Math.floor(risk/(e-stopEUR)),Math.floor(d.allocationCapEUR/e)));
 $("qty").textContent=String(q);$("cost").textContent=money(q*e);$("loss").textContent=money(q*(e-stopEUR));
 $("tp").textContent=money(e+2*(e-stopEUR));
 $("gate").textContent=q>0?"Funding cap: "+money(d.allocationCapEUR)+". Validate the weekly structure and broker pricing before submitting an order.":"Position exceeds risk/funding constraints.";
}
async function load(){
 $("state").textContent="Loading…";
 const t=new URLSearchParams(location.search).get("token");
 if(!t){$("state").textContent="Open your personal URL with ?token=YOUR_READ_TOKEN";return;}
 try{
 const r=await fetch("/api/latest?token="+encodeURIComponent(t),{cache:"no-store"}), j=await r.json();
 if(!r.ok) throw Error(j.error||"Cannot load alert");
 data=j;$("ticker").textContent=j.alert.exchange+":"+j.alert.ticker;
 $("seen").textContent=new Date(j.alert.triggeredAt).toLocaleString();
 $("low").textContent=j.weeklyLowUSD? "$"+j.weeklyLowUSD.toFixed(3):"Unavailable";
 $("fx").textContent=j.usdPerEur?j.usdPerEur.toFixed(5):"Unavailable";
 $("fresh").textContent="Previous week starts "+(j.weekStarting||"?")+" · market as of "+(j.dataAsOf||"?")+" · FX as of "+(j.fxAsOf||"?")+(j.dataError?" · Market error: "+j.dataError:"")+(j.fxError?" · FX error: "+j.fxError:"");
 $("state").textContent="Alert loaded. Confirm the ticker before trading.";calc();
 }catch(e){data=null;$("state").textContent=e.message;calc();}
}
$("entry").addEventListener("input",calc);
$("minus").onclick=()=>{risk=Math.max(50,risk-50);calc()};
$("plus").onclick=()=>{risk+=50;calc()};
$("refresh").onclick=load;
load();
</script></html>