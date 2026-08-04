/**
 * app.js
 * -------------------------------------------------------------------------
 * Sales Revenue Dashboard — client logic.
 * ข้อมูลจริงมาจาก Google Apps Script Web App (ตั้งค่า URL ใน config.js)
 * ไม่มีการเรียก Google Drive API หรือฝัง API Key ใด ๆ ในไฟล์นี้
 * -------------------------------------------------------------------------
 */

/* ============ CONFIG: schema + header aliases (Thai + English fallback) ============ */
const SCHEMA = [
  {key:'date', type:'date', aliases:['วันที่เอกสาร','date','invoice_date']},
  {key:'invoice_no', type:'text', aliases:['เลขที่เอกสาร','invoice_no','invoice no']},
  {key:'channel', type:'text', aliases:['แผนก','ช่องทางขาย','channel','department']},
  {key:'category', type:'text', aliases:['กลุ่มสินค้า','category']},
  {key:'sku', type:'text', aliases:['รหัสสินค้า','sku']},
  {key:'product_name', type:'text', aliases:['ชื่อสินค้า','product_name','product name']},
  {key:'quantity', type:'number', aliases:['จำนวน','quantity']},
  {key:'unit_price', type:'number', aliases:['ราคา / หน่วย','ราคาต่อหน่วย','unit_price','unit price']},
  {key:'net_sales', type:'number', aliases:['รวมก่อนภาษี','ยอดขายก่อนภาษี','net_sales','net sales']},
  {key:'vat', type:'number', aliases:['ภาษีมูลค่าเพิ่ม','vat']},
  {key:'revenue', type:'number', aliases:['รวมหลังภาษี','ยอดขายรวมภาษี','revenue']},
  {key:'customer', type:'text', aliases:['ชื่อลูกค้า','ลูกค้า','customer']},
  {key:'status', type:'text', aliases:['สถานะ','status']},
];
const OPTIONAL = [
  {key:'unit', aliases:['หน่วย','หน่วยหลัก','unit']},
];
// Text fields that fall back to "ไม่ระบุ" instead of an empty label when blank
const TEXT_FALLBACK = ['category','channel','customer','status'];
const MAX_BAD_ROW_RATIO = 0.2; // reject whole file if >20% rows fail to coerce
const SERIES = ['#2a78d6','#e8792a','#1baf7a','#eda100','#e87ba4','#3a8a3a','#6a4ab7','#e34948'];
const TH_MONTHS_FULL = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
// '2024-01' -> 'มกราคม' (no year — used where the axis should read as month names only)
function monthNameOnly(ym){
  return TH_MONTHS_FULL[parseInt(String(ym).split('-')[1],10)-1];
}
const LS_KEY = 'salesDashboard_cache_v1'; // localStorage key for the last successfully-synced dataset

/* ============ STATE ============ */
let backendData = [];         // rows synced automatically from Google Drive via Apps Script
let manualData = [];          // rows added via the manual-upload fallback tab (session only)
let masterData = [];          // merged + deduped rows actually rendered
let seenRowKeys = new Set();  // dedup key: invoice_no|sku|year_month|quantity
let ingestLog = [];
let refreshTimer = null;
let lastSyncOk = false;

let filters = { start:null, end:null, years:new Set(), channels:new Set(), categories:new Set(), skus:new Set(), status:new Set() };
let trendMode = 'total';
let compMode = 'channel';
let compSelected = new Set();
let detailPage = 1;
const PAGE_SIZE = 20;
let detailSort = {col:'date', dir:-1};
let topSort = {col:'revenue', dir:-1};

/* ============ DEMO DATA (shown until real data connected) ============ */
function genDemoData(){
  const channels=['หน้าร้าน','Shopee','Lazada','HomePro','NocNoc','Office_Mate','Amaze'];
  const cats=['เครื่องมือไฟฟ้า','อุปกรณ์ทำสวน','วัสดุก่อสร้าง','สีและเคมีภัณฑ์','ประปา','ไฟฟ้าและแสงสว่าง','เฟอร์นิเจอร์','ของใช้ในบ้าน'];
  const rows=[]; let inv=1000;
  for(let y=2024;y<=2025;y++){
    for(let m=0;m<12;m++){
      const seasonal = 1 + 0.25*Math.sin((m/12)*2*Math.PI) + (y===2025?0.12:0);
      const linesThisMonth = Math.round(180*seasonal);
      for(let i=0;i<linesThisMonth;i++){
        const day = 1+Math.floor(Math.random()*27);
        const ch = channels[Math.floor(Math.random()*channels.length)];
        const cat = cats[Math.floor(Math.random()*cats.length)];
        const sku = cat.slice(0,2)+'-'+(100+Math.floor(Math.random()*40));
        const qty = 1+Math.floor(Math.random()*8);
        const price = Math.round((50+Math.random()*1500));
        const net = qty*price;
        const vat = Math.round(net*0.07);
        inv++;
        rows.push({
          date:new Date(y,m,day), invoice_no:'INV-'+y+'-'+inv, channel:ch, category:cat, sku:sku,
          product_name:cat+' รุ่น '+sku, quantity:qty, unit:'ชิ้น', unit_price:price, net_sales:net, vat:vat,
          revenue:net+vat, customer:'ลูกค้า #'+(1+Math.floor(Math.random()*400)),
          status:(Math.random()<0.82?'Paid':(Math.random()<0.6?'Pending':'Partial')),
          year:y, month:m+1, year_month:y+'-'+String(m+1).padStart(2,'0'), quarter:'Q'+(Math.floor(m/3)+1),
          _source:'demo'
        });
      }
    }
  }
  return rows;
}

/* ============ INGESTION / VALIDATION (used by the manual-upload fallback) ============ */
function normHeader(h){ return String(h||'').trim().toLowerCase(); }

function resolveHeaderMap(headers){
  const map = {};
  const normed = headers.map(normHeader);
  for(const f of SCHEMA.concat(OPTIONAL)){
    const idx = normed.findIndex(h => f.aliases.some(a=>normHeader(a)===h));
    if(idx>-1) map[f.key] = headers[idx];
  }
  return map;
}

function coerceDate(v){
  if(v instanceof Date && !isNaN(v)) return v;
  if(typeof v === 'number'){ // excel serial
    const d = XLSX.SSF.parse_date_code(v); if(d) return new Date(d.y,d.m-1,d.d);
  }
  const d = new Date(v); return isNaN(d) ? null : d;
}
function coerceNumber(v){
  if(typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/,/g,'').replace(/[^\d.\-]/g,''));
  return isNaN(n) ? null : n;
}

function validateAndTransform(rows, headers, fileName){
  const hmap = resolveHeaderMap(headers);
  const missing = SCHEMA.filter(f=>!hmap[f.key]).map(f=>f.aliases[0]);
  if(missing.length){
    logIngest(fileName, 'reject', 'ขาดคอลัมน์ที่จำเป็น: '+missing.join(', '));
    return null;
  }
  let bad = 0; const out = [];
  for(const r of rows){
    const rec = {};
    let ok = true;
    for(const f of SCHEMA){
      let val = r[hmap[f.key]];
      if(f.type==='date') val = coerceDate(val);
      else if(f.type==='number') val = coerceNumber(val);
      else val = (val===undefined||val===null) ? '' : String(val).trim();
      if((f.type==='date'||f.type==='number') && (val===null||val===undefined)){ ok=false; }
      if(f.type==='text' && !val && TEXT_FALLBACK.includes(f.key)) val = 'ไม่ระบุ';
      rec[f.key] = val;
    }
    if(hmap['unit']) rec.unit = String(r[hmap['unit']]||'').trim();
    if(!ok){ bad++; continue; }
    rec.year = rec.date.getFullYear();
    rec.month = rec.date.getMonth()+1;
    rec.year_month = rec.year+'-'+String(rec.month).padStart(2,'0');
    rec.quarter = 'Q'+(Math.floor((rec.month-1)/3)+1);
    rec._source = fileName;
    out.push(rec);
  }
  if(rows.length && bad/rows.length > MAX_BAD_ROW_RATIO){
    logIngest(fileName, 'reject', `พบข้อมูลผิดรูปแบบ ${bad}/${rows.length} แถว (เกิน ${MAX_BAD_ROW_RATIO*100}%) — ปฏิเสธไฟล์ทั้งไฟล์เพื่อป้องกันแดชบอร์ดพัง`);
    return null;
  }
  if(bad>0) logIngest(fileName, 'warn', `ข้ามแถวที่ผิดรูปแบบ ${bad} แถว จากทั้งหมด ${rows.length}`);
  return out;
}

function rowKey(r){ return [r.invoice_no, r.sku, r.year_month, r.quantity].join('|'); }

function rebuildMasterData(){
  masterData = [];
  seenRowKeys = new Set();
  for(const r of [...backendData, ...manualData]){
    const key = rowKey(r);
    if(seenRowKeys.has(key)) continue;
    seenRowKeys.add(key);
    masterData.push(r);
  }
  if(!masterData.length){
    masterData = genDemoData();
  }
  onDataChanged();
}

function logIngest(fileName, level, msg){
  ingestLog.unshift({time:new Date(), fileName, level, msg});
  renderIngestLog();
}
function renderIngestLog(){
  const el = document.getElementById('ingestLog');
  if(!el) return;
  el.innerHTML = ingestLog.map(l=>{
    const c = l.level==='reject'?'status-bad':(l.level==='warn'?'status-wait':'status-ok');
    return `<div style="padding:5px 2px;border-bottom:1px solid var(--gray-100);">
      <span class="${c}">[${l.level.toUpperCase()}]</span> ${l.time.toLocaleTimeString('th-TH')} — <b>${l.fileName}</b>: ${l.msg}
    </div>`;
  }).join('') || '<div class="empty">ยังไม่มี log</div>';
}

function ingestWorkbookBuffer(fileName, buffer, isText){
  let wb;
  try{
    wb = isText ? XLSX.read(buffer, {type:'string'}) : XLSX.read(buffer, {type:'array'});
  }catch(e){
    logIngest(fileName,'reject','ไม่สามารถอ่านไฟล์ได้ ('+e.message+')'); return;
  }
  // A workbook may hold one sheet total, or one sheet per year (e.g. "2024","2025","2026") —
  // process every sheet that contains rows, so multi-year exports import in one pass.
  let anyImported = false;
  for(const sheetName of wb.SheetNames){
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {defval:null, raw:true});
    if(!rows.length) continue;
    const label = wb.SheetNames.length>1 ? `${fileName} [${sheetName}]` : fileName;
    const headers = Object.keys(rows[0]);
    const clean = validateAndTransform(rows, headers, label);
    if(!clean) continue;
    let added=0, dup=0;
    for(const r of clean){
      const key = rowKey(r);
      if(manualData.some(x=>rowKey(x)===key) || backendData.some(x=>rowKey(x)===key)){ dup++; continue; }
      manualData.push(r); added++;
    }
    logIngest(label,'ok', `นำเข้าสำเร็จ ${added} แถว${dup?` (ข้ามซ้ำ ${dup} แถว)`:''}`);
    anyImported = true;
  }
  if(!anyImported) logIngest(fileName,'reject','ไม่พบชีตที่มีข้อมูลตรง schema ในไฟล์นี้');
  rebuildMasterData();
}

/* ============ MANUAL UPLOAD TAB (fallback only — no API key involved) ============ */
function handleFiles(fileListObj){
  Array.from(fileListObj).forEach(file=>{
    const isCsv = /\.csv$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = ev => ingestWorkbookBuffer(file.name, isCsv ? ev.target.result : new Uint8Array(ev.target.result), isCsv);
    if(isCsv) reader.readAsText(file); else reader.readAsArrayBuffer(file);
  });
}
function initManualUpload(){
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  if(!dz || !fileInput) return;
  dz.addEventListener('dragover', e=>{e.preventDefault(); dz.classList.add('drag');});
  dz.addEventListener('dragleave', ()=>dz.classList.remove('drag'));
  dz.addEventListener('drop', e=>{
    e.preventDefault(); dz.classList.remove('drag');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', e=>handleFiles(e.target.files));
}
function toggleDatasource(){
  const el = document.getElementById('datasource');
  el.style.display = el.style.display==='none' ? 'block' : 'none';
}

/* ============ BACKEND SYNC (Google Apps Script Web App — no client API key) ============ */
function setSyncInfo(text){
  const el = document.getElementById('syncInfo');
  if(el) el.textContent = text;
}
function toggleRefreshBtn(disabled){
  const btn = document.getElementById('refreshBtn');
  if(btn) btn.disabled = disabled;
}

// Apps Script returns dates as ISO strings (JSON has no native Date type) — restore them here.
function reviveBackendRow(r){
  return Object.assign({}, r, { date: new Date(r.date) });
}

// Cache the last successfully-synced dataset in the browser so a page reload (or a temporary
// network hiccup) shows real data again instead of falling back to the demo dataset.
function saveSyncCache(fileCount, syncedAtISO){
  try{
    localStorage.setItem(LS_KEY, JSON.stringify({ data: backendData, syncedAt: syncedAtISO || new Date().toISOString(), fileCount: fileCount||0 }));
  }catch(e){ /* storage unavailable (quota / private browsing) — not critical, just skip caching */ }
}
function loadSyncCache(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(!parsed || !Array.isArray(parsed.data) || !parsed.data.length) return null;
    parsed.data = parsed.data.map(reviveBackendRow);
    return parsed;
  }catch(e){ return null; }
}

async function fetchFromBackend(){
  if(!CONFIG.API_URL){
    if(!backendData.length) setSyncInfo('ยังไม่ได้ตั้งค่า API_URL ใน config.js — กำลังแสดงข้อมูลตัวอย่าง (Demo)');
    return;
  }
  toggleRefreshBtn(true);
  setSyncInfo('กำลังซิงก์ข้อมูลจาก Google Drive...');
  try{
    const res = await fetch(CONFIG.API_URL + (CONFIG.API_URL.includes('?') ? '&' : '?') + 'v=' + Date.now());
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if(!json.ok) throw new Error(json.error || 'ไม่ทราบสาเหตุ');
    backendData = (json.data || []).map(reviveBackendRow);
    lastSyncOk = true;
    const syncedAtDate = json.syncedAt ? new Date(json.syncedAt) : new Date();
    setSyncInfo(`ซิงก์ล่าสุด: ${syncedAtDate.toLocaleString('th-TH')} · ${json.fileCount||0} ไฟล์ · ${backendData.length.toLocaleString('th-TH')} แถว`);
    saveSyncCache(json.fileCount||0, syncedAtDate.toISOString());
    rebuildMasterData();
  }catch(e){
    lastSyncOk = false;
    // Keep whatever backendData we already had (cached-from-last-visit or freshly synced) —
    // only drop to the demo dataset if we truly have nothing.
    setSyncInfo('เชื่อมต่อ Apps Script ไม่สำเร็จ: ' + e.message + (backendData.length ? ' — แสดงข้อมูลที่ซิงก์ไว้ล่าสุด' : ' — แสดงข้อมูลตัวอย่าง (Demo) แทน'));
    rebuildMasterData();
  }finally{
    toggleRefreshBtn(false);
  }
}
function manualRefresh(){ fetchFromBackend(); }
function startAutoRefresh(){
  if(refreshTimer) clearInterval(refreshTimer);
  const minutes = Math.max(1, Number(CONFIG.AUTO_REFRESH_MINUTES) || 15);
  refreshTimer = setInterval(fetchFromBackend, minutes*60000);
}

/* ============ FILTER UI (multi-select boxes) ============ */
function buildMultiSelect(containerId, options, selectedSet, onChange, withSearch){
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  el.classList.add('msbox');
  const btn = document.createElement('div'); btn.className='msbtn';
  const panel = document.createElement('div'); panel.className='mspanel';
  function updateBtnLabel(){
    btn.textContent = selectedSet.size===0 ? 'ทั้งหมด' : (selectedSet.size===1 ? [...selectedSet][0] : `${selectedSet.size} รายการ`);
  }
  updateBtnLabel();
  if(withSearch){
    const s = document.createElement('input'); s.className='msearch'; s.placeholder='ค้นหา...';
    s.oninput = ()=>{ panel.querySelectorAll('label').forEach(l=>{ l.style.display = l.dataset.v.toLowerCase().includes(s.value.toLowerCase())?'flex':'none'; }); };
    panel.appendChild(s);
  }
  options.forEach(opt=>{
    const lab = document.createElement('label'); lab.dataset.v = opt;
    const cb = document.createElement('input'); cb.type='checkbox'; cb.checked = selectedSet.has(opt);
    cb.onchange = ()=>{ if(cb.checked) selectedSet.add(opt); else selectedSet.delete(opt); updateBtnLabel(); onChange(); };
    lab.appendChild(cb); lab.appendChild(document.createTextNode(opt));
    panel.appendChild(lab);
  });
  btn.onclick = (e)=>{ e.stopPropagation(); el.classList.toggle('open'); };
  el.appendChild(btn); el.appendChild(panel);
}
document.addEventListener('click', ()=>document.querySelectorAll('.msbox.open').forEach(b=>b.classList.remove('open')));

function refreshFilterOptions(){
  const years = [...new Set(masterData.map(r=>r.year))].sort((a,b)=>a-b);
  const channels = [...new Set(masterData.map(r=>r.channel))].sort();
  const categories = [...new Set(masterData.map(r=>r.category))].sort();
  const statuses = [...new Set(masterData.map(r=>r.status))].sort();
  let products = masterData;
  if(filters.categories.size) products = products.filter(r=>filters.categories.has(r.category));
  const productOpts = [...new Set(products.map(r=>r.product_name))].sort();

  buildMultiSelect('msYear', years.map(String), filters.years, onFilterChange, false);
  buildMultiSelect('msChannel', channels, filters.channels, onFilterChange, true);
  buildMultiSelect('msCategory', categories, filters.categories, ()=>{ refreshFilterOptions(); onFilterChange(); }, true);
  buildMultiSelect('msProduct', productOpts, filters.skus, onFilterChange, true);
  buildMultiSelect('msStatus', statuses, filters.status, onFilterChange, false);
}
function onFilterChange(){ detailPage=1; renderAll(); }

function applyQuickRange(){
  const v = document.getElementById('fQuick').value;
  const now = new Date();
  let start=null, end=null;
  if(v==='this_year'){ start=new Date(now.getFullYear(),0,1); end=new Date(now.getFullYear(),11,31); }
  else if(v==='last_year'){ start=new Date(now.getFullYear()-1,0,1); end=new Date(now.getFullYear()-1,11,31); }
  else if(v==='last12'){ end=now; start=new Date(now.getFullYear(),now.getMonth()-11,1); }
  else if(v==='all'){ start=null; end=null; }
  document.getElementById('fStart').value = start ? start.toISOString().slice(0,10) : '';
  document.getElementById('fEnd').value = end ? end.toISOString().slice(0,10) : '';
  filters.start = start; filters.end = end;
  onFilterChange();
}
['fStart','fEnd'].forEach(id=>document.getElementById(id).addEventListener('change', e=>{
  filters.start = document.getElementById('fStart').value ? new Date(document.getElementById('fStart').value) : null;
  filters.end = document.getElementById('fEnd').value ? new Date(document.getElementById('fEnd').value) : null;
  onFilterChange();
}));
function resetFilters(){
  filters = { start:null, end:null, years:new Set(), channels:new Set(), categories:new Set(), skus:new Set(), status:new Set() };
  document.getElementById('fStart').value=''; document.getElementById('fEnd').value=''; document.getElementById('fQuick').value='';
  refreshFilterOptions(); renderAll();
}

/* ============ FILTERED DATA ============ */
function getFiltered(){
  return masterData.filter(r=>{
    if(filters.start && r.date < filters.start) return false;
    if(filters.end && r.date > filters.end) return false;
    if(filters.years.size && !filters.years.has(String(r.year))) return false;
    if(filters.channels.size && !filters.channels.has(r.channel)) return false;
    if(filters.categories.size && !filters.categories.has(r.category)) return false;
    if(filters.skus.size && !filters.skus.has(r.product_name)) return false;
    if(filters.status.size && !filters.status.has(r.status)) return false;
    return true;
  });
}
function sum(arr, fn){ return arr.reduce((a,r)=>a+fn(r),0); }
function fmtTHB(n){ return '฿'+Number(n||0).toLocaleString('th-TH',{minimumFractionDigits:0,maximumFractionDigits:0}); }
function fmtNum(n){ return Number(n||0).toLocaleString('th-TH'); }

/* ============ KPI ============ */
function renderKPI(){
  const data = getFiltered();
  const revenue = sum(data, r=>r.revenue);
  const orders = new Set(data.map(r=>r.invoice_no)).size;
  const aov = orders ? revenue/orders : 0;
  const units = sum(data, r=>r.quantity);

  // period-over-period: previous period of equal length right before current range
  let prevRevenue=null, prevOrders=null, prevAov=null, prevUnits=null;
  const range = dataDateRange(data);
  if(range.start && range.end){
    const lenMs = range.end - range.start;
    const prevEnd = new Date(range.start.getTime()-86400000);
    const prevStart = new Date(prevEnd.getTime()-lenMs);
    const prevData = masterData.filter(r=>r.date>=prevStart && r.date<=prevEnd &&
      (!filters.channels.size||filters.channels.has(r.channel)) &&
      (!filters.categories.size||filters.categories.has(r.category)) &&
      (!filters.skus.size||filters.skus.has(r.product_name)) &&
      (!filters.status.size||filters.status.has(r.status)));
    prevRevenue = sum(prevData, r=>r.revenue);
    prevOrders = new Set(prevData.map(r=>r.invoice_no)).size;
    prevAov = prevOrders ? prevRevenue/prevOrders : 0;
    prevUnits = sum(prevData, r=>r.quantity);
  }
  function deltaHtml(cur, prev){
    if(prev===null || prev===0) return '';
    const pct = ((cur-prev)/prev*100);
    const up = pct>=0;
    return `<div class="delta ${up?'up':'down'}">${up?'▲':'▼'} ${Math.abs(pct).toFixed(1)}% เทียบช่วงก่อน</div>`;
  }
  const cards = [
    {lbl:'ยอดขายรวม (Total Revenue)', val:fmtTHB(revenue), delta:deltaHtml(revenue,prevRevenue)},
    {lbl:'จำนวนบิล (Total Orders)', val:fmtNum(orders), delta:deltaHtml(orders,prevOrders)},
    {lbl:'มูลค่าเฉลี่ยต่อบิล (AOV)', val:fmtTHB(aov), delta:deltaHtml(aov,prevAov)},
    {lbl:'จำนวนสินค้าขายได้ (Units)', val:fmtNum(units), delta:deltaHtml(units,prevUnits)},
  ];
  document.getElementById('kpiRow').innerHTML = cards.map(c=>`
    <div class="card kpi-card"><div class="lbl">${c.lbl}</div><div class="val">${c.val}</div>${c.delta}</div>
  `).join('');
}
function dataDateRange(data){
  if(!data.length) return {start:null,end:null};
  let start=data[0].date, end=data[0].date;
  data.forEach(r=>{ if(r.date<start) start=r.date; if(r.date>end) end=r.date; });
  return {start,end};
}

/* ============ TREND CHART ============ */
let trendChartObj=null;
function setTrendMode(m){
  trendMode=m;
  document.querySelectorAll('#trendToggle button').forEach(b=>b.classList.toggle('on', b.dataset.mode===m));
  renderTrend();
}
function renderTrend(){
  const data = getFiltered();
  const months = [...new Set(data.map(r=>r.year_month))].sort();
  let datasets = [];
  if(trendMode==='total'){
    const years = [...new Set(data.map(r=>r.year))].sort((a,b)=>a-b);
    if(years.length<=2){
      datasets = years.map((y,i)=>{
        const byMonth = Array.from({length:12},(_,m)=>sum(data.filter(r=>r.year===y && r.month===m+1), r=>r.revenue));
        return {label:String(y), data:byMonth, borderColor:SERIES[i%SERIES.length], backgroundColor:SERIES[i%SERIES.length]+'22', tension:.3, borderWidth:2, pointRadius:2, fill:false};
      });
      renderChart('trendChart', TH_MONTHS_FULL, datasets, 'trendLegend');
      return;
    } else {
      datasets = [{label:'รวมทั้งหมด', data:months.map(m=>sum(data.filter(r=>r.year_month===m), r=>r.revenue)), borderColor:SERIES[0], backgroundColor:SERIES[0]+'22', tension:.3, borderWidth:2, pointRadius:2, fill:true}];
    }
  } else {
    const groupField = trendMode;
    let groups = [...new Set(data.map(r=>r[groupField]))];
    const totals = groups.map(g=>({g, t:sum(data.filter(r=>r[groupField]===g), r=>r.revenue)})).sort((a,b)=>b.t-a.t);
    const top = totals.slice(0,7).map(x=>x.g);
    datasets = top.map((g,i)=>({
      label:g, data:months.map(m=>sum(data.filter(r=>r.year_month===m && r[groupField]===g), r=>r.revenue)),
      borderColor:SERIES[i%SERIES.length], backgroundColor:SERIES[i%SERIES.length]+'22', tension:.3, borderWidth:2, pointRadius:1, fill:false
    }));
  }
  renderChart('trendChart', months.map(monthNameOnly), datasets, 'trendLegend');
}
function renderChart(canvasId, labels, datasets, legendId){
  const ctx = document.getElementById(canvasId);
  if(canvasId==='trendChart' && trendChartObj){ trendChartObj.destroy(); }
  const chart = new Chart(ctx, {
    type:'line',
    data:{labels, datasets},
    options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
      scales:{x:{ticks:{color:'#647388',font:{size:10}}, grid:{display:false}},
              y:{ticks:{color:'#647388',font:{size:10}, callback:v=>fmtTHB(v)}, grid:{color:'#eef1f5'}}}}
  });
  if(canvasId==='trendChart') trendChartObj = chart;
  if(legendId){
    document.getElementById(legendId).innerHTML = datasets.map((d,i)=>`<span><span class="dot" style="background:${d.borderColor}"></span>${d.label}</span>`).join('');
  }
}

/* ============ YEARLY REVENUE COMPARISON ============ */
// Uses every filter EXCEPT the "ปี" (year) filter itself, so all years stay visible
// side-by-side no matter which year(s) happen to be selected elsewhere on the page.
function getFilteredExceptYear(){
  return masterData.filter(r=>{
    if(filters.start && r.date < filters.start) return false;
    if(filters.end && r.date > filters.end) return false;
    if(filters.channels.size && !filters.channels.has(r.channel)) return false;
    if(filters.categories.size && !filters.categories.has(r.category)) return false;
    if(filters.skus.size && !filters.skus.has(r.product_name)) return false;
    if(filters.status.size && !filters.status.has(r.status)) return false;
    return true;
  });
}
let yearlyChartObj=null;
function renderYearlyChart(){
  const data = getFilteredExceptYear();
  const years = [...new Set(data.map(r=>r.year))].sort((a,b)=>a-b);
  const totals = years.map(y=>sum(data.filter(r=>r.year===y), r=>r.revenue));
  if(yearlyChartObj) yearlyChartObj.destroy();
  yearlyChartObj = new Chart(document.getElementById('yearlyChart'), {
    type:'bar',
    data:{labels:years.map(String), datasets:[{
      data:totals,
      backgroundColor:years.map(y=>filters.years.has(String(y)) ? SERIES[1] : SERIES[0]),
      borderRadius:6, maxBarThickness:70
    }]},
    options:{responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display:false}, tooltip:{callbacks:{label:(c)=>{
        const i = c.dataIndex, cur = totals[i], prev = i>0 ? totals[i-1] : null;
        let extra = '';
        if(prev){ const pct = (cur-prev)/prev*100; extra = ' ('+(pct>=0?'▲':'▼')+' '+Math.abs(pct).toFixed(1)+'% เทียบปีก่อน)'; }
        return fmtTHB(cur)+extra;
      }}}},
      onClick:(e,els)=>{ if(els.length){ const y=String(years[els[0].index]); filters.years = filters.years.has(y)&&filters.years.size===1? new Set(): new Set([y]); refreshFilterOptions(); renderAll(); } },
      scales:{x:{ticks:{color:'#1c2b3a',font:{size:12,weight:600}}, grid:{display:false}},
              y:{ticks:{color:'#647388', callback:v=>fmtTHB(v)}, grid:{color:'#eef1f5'}}}}
  });
}

/* ============ CHANNEL / CATEGORY CHARTS ============ */
let channelBarObj=null, channelDonutObj=null, categoryBarObj=null, statusDonutObj=null;
function groupSum(data, field){
  const m = new Map();
  data.forEach(r=>m.set(r[field], (m.get(r[field])||0)+r.revenue));
  return [...m.entries()].sort((a,b)=>b[1]-a[1]);
}
// Charts with many distinct values (e.g. dozens of product categories) become unreadable —
// rotated/overlapping axis labels, or bars too thin to click. This keeps the top N by revenue
// and folds everything else into a single "other" bucket, returning which raw keys that
// bucket represents so a click on it can still filter to the right underlying rows.
function topNGroup(pairs, n, otherLabel){
  if(pairs.length<=n) return {items:pairs, otherKeys:null};
  const top = pairs.slice(0,n);
  const rest = pairs.slice(n);
  const restSum = rest.reduce((s,x)=>s+x[1],0);
  const otherKeys = rest.map(x=>x[0]);
  return {items: restSum>0 ? [...top,[otherLabel,restSum]] : top, otherKeys};
}
function renderChannelCharts(){
  const data = getFiltered();
  const g = groupSum(data,'channel');
  if(channelBarObj) channelBarObj.destroy();
  channelBarObj = new Chart(document.getElementById('channelBar'), {
    type:'bar',
    data:{labels:g.map(x=>x[0]), datasets:[{data:g.map(x=>x[1]), backgroundColor:SERIES[0], borderRadius:4}]},
    options:{indexAxis:'y', responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>fmtTHB(c.raw)}}},
      onClick:(e,els)=>{ if(els.length){ const ch=g[els[0].index][0]; filters.channels = filters.channels.has(ch)&&filters.channels.size===1? new Set(): new Set([ch]); refreshFilterOptions(); renderAll(); } },
      scales:{x:{ticks:{color:'#647388',callback:v=>fmtTHB(v)}, grid:{color:'#eef1f5'}}, y:{ticks:{color:'#1c2b3a',font:{size:11}}, grid:{display:false}}}}
  });
  if(channelDonutObj) channelDonutObj.destroy();
  channelDonutObj = new Chart(document.getElementById('channelDonut'), {
    type:'doughnut',
    data:{labels:g.map(x=>x[0]), datasets:[{data:g.map(x=>x[1]), backgroundColor:g.map((_,i)=>SERIES[i%SERIES.length])}]},
    options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom', labels:{boxWidth:10, font:{size:11}}}, tooltip:{callbacks:{label:c=>c.label+': '+fmtTHB(c.raw)}}}}
  });
  const gcRaw = groupSum(data,'category');
  const catGrouped = topNGroup(gcRaw, 10, 'อื่นๆ');
  const gc = catGrouped.items;
  if(categoryBarObj) categoryBarObj.destroy();
  categoryBarObj = new Chart(document.getElementById('categoryBar'), {
    type:'bar',
    data:{labels:gc.map(x=>x[0]), datasets:[{data:gc.map(x=>x[1]), backgroundColor:gc.map(x=>x[0]==='อื่นๆ'?'#98a3b3':SERIES[2]), borderRadius:4}]},
    options:{indexAxis:'y', responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}, tooltip:{callbacks:{label:c=>fmtTHB(c.raw)}}},
      onClick:(e,els)=>{
        if(!els.length) return;
        const label = gc[els[0].index][0];
        if(label==='อื่นๆ' && catGrouped.otherKeys){
          const same = filters.categories.size===catGrouped.otherKeys.length && catGrouped.otherKeys.every(k=>filters.categories.has(k));
          filters.categories = same ? new Set() : new Set(catGrouped.otherKeys);
        } else {
          filters.categories = filters.categories.has(label)&&filters.categories.size===1? new Set(): new Set([label]);
        }
        refreshFilterOptions(); renderAll();
      },
      scales:{x:{ticks:{color:'#647388', callback:v=>fmtTHB(v)}, grid:{color:'#eef1f5'}}, y:{ticks:{color:'#1c2b3a',font:{size:11}}, grid:{display:false}}}}
  });
  const gs = groupSum(data,'status');
  if(statusDonutObj) statusDonutObj.destroy();
  const statusColors = {Paid:'#1ba97a', Cash:'#1ba97a', 'Credit Card':'#2a78d6', Pending:'#eda100', 'Billing Note':'#eda100', Partial:'#e4514f', Debtor:'#e4514f'};
  statusDonutObj = new Chart(document.getElementById('statusDonut'), {
    type:'doughnut',
    data:{labels:gs.map(x=>x[0]), datasets:[{data:gs.map(x=>x[1]), backgroundColor:gs.map((x,i)=>statusColors[x[0]]||SERIES[i%SERIES.length])}]},
    options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom', labels:{boxWidth:10,font:{size:11}}}, tooltip:{callbacks:{label:c=>c.label+': '+fmtTHB(c.raw)}}}}
  });
}

/* ============ TOP PRODUCTS ============ */
function renderTopProducts(){
  const data = getFiltered();
  const n = parseInt(document.getElementById('topN').value,10);
  const q = document.getElementById('prodSearch').value.trim().toLowerCase();
  const m = new Map();
  data.forEach(r=>{
    const key = r.sku;
    if(!m.has(key)) m.set(key, {sku:r.sku, name:r.product_name, category:r.category, qty:0, revenue:0});
    const o = m.get(key); o.qty += r.quantity; o.revenue += r.revenue;
  });
  let rows = [...m.values()];
  if(q) rows = rows.filter(r=>r.sku.toLowerCase().includes(q)||r.name.toLowerCase().includes(q));
  const totalRev = sum(rows, r=>r.revenue) || 1;
  rows.sort((a,b)=>(b[topSort.col]-a[topSort.col])*topSort.dir*-1);
  rows = rows.slice(0,n);
  const cols = [['sku','รหัส'],['name','ชื่อสินค้า'],['category','หมวดหมู่'],['qty','จำนวนขาย'],['revenue','ยอดขาย'],['pct','% ของยอดรวม']];
  const thead = '<thead><tr>'+cols.map(c=>`<th onclick="setTopSort('${c[0]}')">${c[1]}</th>`).join('')+'</tr></thead>';
  const tbody = '<tbody>'+rows.map(r=>`<tr><td>${r.sku}</td><td>${r.name}</td><td>${r.category}</td><td>${fmtNum(r.qty)}</td><td>${fmtTHB(r.revenue)}</td><td>${(r.revenue/totalRev*100).toFixed(1)}%</td></tr>`).join('')+'</tbody>';
  document.getElementById('topProductsTbl').innerHTML = thead+tbody;
}
function setTopSort(col){ topSort.dir = topSort.col===col? -topSort.dir : -1; topSort.col=col; renderTopProducts(); }

/* ============ COMPARISON CHART (always yearly: x-axis = years, one line per selected item) ============ */
function rebuildCompList(){
  const data = masterData;
  const field = compMode = document.getElementById('compMode').value;
  const q = document.getElementById('compSearch').value.trim().toLowerCase();
  let opts = [...new Set(data.map(r=> field==='product' ? r.product_name : r[field]))].sort();
  if(q) opts = opts.filter(o=>o.toLowerCase().includes(q));
  compSelected = new Set([...compSelected].filter(v=>opts.includes(v)));
  const list = document.getElementById('compList');
  list.innerHTML = opts.map(o=>`<label><input type="checkbox" ${compSelected.has(o)?'checked':''} onchange="toggleComp('${o.replace(/'/g,"\\'")}',this)">${o}</label>`).join('') || '<div class="empty">ไม่พบรายการ</div>';
  renderCompChart();
}
function toggleComp(val, cb){
  if(cb.checked){
    if(compSelected.size>=5){ cb.checked=false; alert('เลือกได้สูงสุด 5 รายการ'); return; }
    compSelected.add(val);
  } else compSelected.delete(val);
  renderCompChart();
}
let compChartObj=null;
function renderCompChart(){
  const data = getFiltered();
  const field = compMode==='product' ? 'product_name' : compMode;
  const years = [...new Set(data.map(r=>r.year))].sort((a,b)=>a-b);
  const labels = years.map(String);
  const datasets = [...compSelected].map((val,i)=>({
    label:val, data:years.map(y=>sum(data.filter(r=>r.year===y && r[field]===val), r=>r.revenue)),
    borderColor:SERIES[i%SERIES.length], backgroundColor:SERIES[i%SERIES.length]+'22', tension:.3, borderWidth:2, pointRadius:4, fill:false
  }));
  if(compChartObj) compChartObj.destroy();
  compChartObj = new Chart(document.getElementById('compChart'), {
    type:'line', data:{labels, datasets},
    options:{responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:'bottom', labels:{boxWidth:10,font:{size:11}}}, tooltip:{callbacks:{label:c=>c.dataset.label+': '+fmtTHB(c.raw)}}},
      scales:{x:{ticks:{color:'#1c2b3a',font:{size:12,weight:600}}, grid:{display:false}}, y:{ticks:{color:'#647388',callback:v=>fmtTHB(v)}, grid:{color:'#eef1f5'}}}}
  });
}

/* ============ HEATMAP ============ */
function renderHeatmap(){
  const data = getFiltered();
  const years = [...new Set(data.map(r=>r.year))].sort((a,b)=>a-b);
  const grid = {};
  let max=0;
  for(let m=1;m<=12;m++){ grid[m]={}; years.forEach(y=>{ const v = sum(data.filter(r=>r.year===y&&r.month===m),r=>r.revenue); grid[m][y]=v; if(v>max) max=v; }); }
  let html = '<table class="heat-table"><thead><tr><th>เดือน</th>'+years.map(y=>`<th>${y}</th>`).join('')+'</tr></thead><tbody>';
  for(let m=1;m<=12;m++){
    html += `<tr><td style="text-align:left;color:var(--text-mut);">${TH_MONTHS_FULL[m-1]}</td>`;
    years.forEach(y=>{
      const v = grid[m][y]; const ratio = max? v/max : 0;
      const bg = `rgba(42,120,214,${(0.06+ratio*0.75).toFixed(2)})`;
      html += `<td style="background:${bg};font-weight:${ratio>0.5?600:400};color:${ratio>0.55?'#fff':'#1c2b3a'}">${v? fmtTHB(v):'-'}</td>`;
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('heatmapWrap').innerHTML = years.length? html : '<div class="empty">ไม่มีข้อมูลในช่วงที่เลือก</div>';
}

/* ============ DETAIL TABLE ============ */
function renderDetailTable(){
  let data = getFiltered();
  const q = document.getElementById('detailSearch').value.trim().toLowerCase();
  if(q) data = data.filter(r=> r.invoice_no.toLowerCase().includes(q) || r.product_name.toLowerCase().includes(q) || r.customer.toLowerCase().includes(q));
  data = [...data].sort((a,b)=>{
    const av=a[detailSort.col], bv=b[detailSort.col];
    if(av<bv) return -detailSort.dir; if(av>bv) return detailSort.dir; return 0;
  });
  const total = data.length;
  const totalPages = Math.max(1, Math.ceil(total/PAGE_SIZE));
  if(detailPage>totalPages) detailPage=totalPages;
  const pageRows = data.slice((detailPage-1)*PAGE_SIZE, detailPage*PAGE_SIZE);
  const cols = [['date','วันที่'],['invoice_no','เลขที่เอกสาร'],['channel','ช่องทาง'],['category','หมวดหมู่'],['product_name','สินค้า'],['quantity','จำนวน'],['revenue','ยอดขาย'],['customer','ลูกค้า'],['status','สถานะ']];
  const thead = '<thead><tr>'+cols.map(c=>`<th onclick="setDetailSort('${c[0]}')">${c[1]}${detailSort.col===c[0]?(detailSort.dir>0?' ▲':' ▼'):''}</th>`).join('')+'</tr></thead>';
  const tbody = '<tbody>'+(pageRows.map(r=>`<tr><td>${r.date.toLocaleDateString('th-TH')}</td><td>${r.invoice_no}</td><td>${r.channel}</td><td>${r.category}</td><td>${r.product_name}</td><td>${fmtNum(r.quantity)}</td><td>${fmtTHB(r.revenue)}</td><td>${r.customer}</td><td>${r.status}</td></tr>`).join('') || `<tr><td colspan="9" class="empty">ไม่พบข้อมูล</td></tr>`)+'</tbody>';
  document.getElementById('detailTbl').innerHTML = thead+tbody;
  document.getElementById('pageInfo').textContent = `หน้า ${detailPage}/${totalPages} (${fmtNum(total)} รายการ)`;
  window._detailForExport = data;
}
function setDetailSort(col){ detailSort.dir = detailSort.col===col? -detailSort.dir : -1; detailSort.col=col; renderDetailTable(); }
function pageStep(n){ detailPage = Math.max(1, detailPage+n); renderDetailTable(); }
function exportCSV(){
  const data = window._detailForExport || [];
  const headers = ['วันที่','เลขที่เอกสาร','ช่องทาง','หมวดหมู่','สินค้า','จำนวน','ยอดขาย','ลูกค้า','สถานะ'];
  const lines = [headers.join(',')].concat(data.map(r=>[r.date.toLocaleDateString('th-TH'),r.invoice_no,r.channel,r.category,`"${r.product_name}"`,r.quantity,r.revenue,`"${r.customer}"`,r.status].join(',')));
  const blob = new Blob(['\uFEFF'+lines.join('\n')], {type:'text/csv;charset=utf-8;'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sales_detail_export.csv'; a.click();
}

/* ============ MASTER RENDER ============ */
function onDataChanged(){
  const hasRealData = backendData.length>0 || manualData.length>0;
  document.getElementById('demoBadge').style.display = hasRealData ? 'none' : 'inline-block';
  refreshFilterOptions();
  rebuildCompList();
  renderAll();
}
function renderAll(){
  if(!masterData.length){
    document.getElementById('kpiRow').innerHTML = '<div class="card empty" style="grid-column:1/-1;">ไม่มีข้อมูล — ตรวจสอบการตั้งค่า Apps Script หรืออัปโหลดไฟล์ที่ปุ่ม "อัปโหลดไฟล์ (สำรอง)"</div>';
    return;
  }
  // Each chart renders independently — if one throws (bad data, missing DOM node, etc.)
  // it's logged to the console instead of aborting every chart that comes after it.
  const steps = [renderKPI, renderTrend, renderYearlyChart, renderChannelCharts, renderTopProducts, renderCompChart, renderHeatmap, renderDetailTable];
  for(const step of steps){
    try{ step(); }catch(e){ console.error('renderAll: ' + step.name + ' failed', e); }
  }
}

/* ============ INIT ============ */
(function init(){
  if(!CONFIG.ENABLE_MANUAL_UPLOAD){
    const btns = document.querySelectorAll('header.top .btn.ghost.sm');
    // hide the manual-upload button if disabled via config (2nd ghost button)
    if(btns[1]) btns[1].style.display = 'none';
  }
  initManualUpload();
  const cached = loadSyncCache();
  if(cached){
    backendData = cached.data;
    lastSyncOk = true;
    setSyncInfo(`ข้อมูลที่ซิงก์ไว้ล่าสุด: ${new Date(cached.syncedAt).toLocaleString('th-TH')} · ${cached.fileCount||0} ไฟล์ · ${cached.data.length.toLocaleString('th-TH')} แถว (กำลังซิงก์ข้อมูลใหม่ในพื้นหลัง...)`);
  }
  rebuildMasterData(); // shows cached data immediately if we have it; otherwise falls back to demo data
  fetchFromBackend();
  startAutoRefresh();
})();
