/* ===========================================================
   MEU FINANCEIRO — motor de dados
   Persistência: window.storage (pessoal, não compartilhado)
   Uma única chave guarda todo o estado (evita chamadas em excesso)
=========================================================== */
const STORAGE_KEY = 'meufinanceiro:state:v1';

const DEFAULT_STATE = () => ({
  accounts: [
    { id: uid(), nome: 'Carteira', credito: false, fechamento: null, vencimento: null, favorito: true }
  ],
  categories: [
    { id: uid(), nome: 'Casa', essencial: true, favorito: true },
    { id: uid(), nome: 'Alimentação', essencial: true, favorito: true },
    { id: uid(), nome: 'Transporte', essencial: true, favorito: false },
    { id: uid(), nome: 'Saúde', essencial: true, favorito: false },
    { id: uid(), nome: 'Lazer', essencial: false, favorito: false },
    { id: uid(), nome: 'Viagens', essencial: false, favorito: false },
    { id: uid(), nome: 'Outros', essencial: false, favorito: false }
  ],
  entries: [],          // lançamentos (despesa/receita/transferência)
  fixedExpenses: [],    // gastos fixos mensais
  fixedIncomes: [],     // entradas fixas (salário etc.)
  goals: {},            // { categoriaId: valorMetaMensal }
  groups: [],           // grupos de gastos
  investmentTypes: [{ id: uid(), nome: 'Reserva de emergência' }],
  investments: [],      // aportes
  settings: {
    poupancaMetaPct: 15,
    theme: 'dark'
  }
});

let STATE = null;
let saveTimer = null;

function uid(){ return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

function fmtMoney(v){
  const n = Number(v)||0;
  return n.toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
}
function fmtDate(iso){
  const d = new Date(iso+'T00:00:00');
  return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit' });
}
function todayISO(){ return new Date().toISOString().slice(0,10); }
function monthKey(iso){ return iso.slice(0,7); } // YYYY-MM
function currentMonthKey(){ return monthKey(todayISO()); }
function monthLabel(mk){
  const [y,m] = mk.split('-').map(Number);
  const d = new Date(y, m-1, 1);
  return d.toLocaleDateString('pt-BR', { month:'long', year:'numeric' });
}

// Detecta o ambiente: dentro do chat da Claude (window.storage) ou
// hospedado/aberto como app de verdade (localStorage do navegador).
const HAS_CLAUDE_STORAGE = typeof window.storage !== 'undefined';

async function loadState(){
  try{
    let raw = null;
    if(HAS_CLAUDE_STORAGE){
      const res = await window.storage.get(STORAGE_KEY, false);
      raw = res && res.value;
    } else {
      raw = localStorage.getItem(STORAGE_KEY);
    }
    if(raw){
      STATE = JSON.parse(raw);
      // garante que campos novos existam se o app evoluir
      const def = DEFAULT_STATE();
      for(const k in def){ if(!(k in STATE)) STATE[k] = def[k]; }
      return;
    }
  }catch(e){ /* chave não existe ainda */ }
  STATE = DEFAULT_STATE();
  await persist();
}

async function persist(){
  clearTimeout(saveTimer);
  return new Promise(resolve=>{
    saveTimer = setTimeout(async ()=>{
      try{
        if(HAS_CLAUDE_STORAGE){
          await window.storage.set(STORAGE_KEY, JSON.stringify(STATE), false);
        } else {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE));
        }
      }catch(e){ console.error('Falha ao salvar', e); showToast('Não consegui salvar agora — tente de novo'); }
      resolve();
    }, 180);
  });
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2200);
}

/* ---------- Getters derivados ---------- */

function accountById(id){ return STATE.accounts.find(a=>a.id===id); }
function categoryById(id){ return STATE.categories.find(c=>c.id===id); }

function entriesOfMonth(mk){
  return STATE.entries.filter(e => e.tipo !== 'transferencia' && monthKey(e.data) === mk);
}

// dinheiro que efetivamente passou pela conta (débito/dinheiro/pix + receitas) no mês
function saldoDoMes(mk){
  const es = entriesOfMonth(mk);
  let recebido = 0, saiu = 0;
  es.forEach(e=>{
    if(e.tipo === 'receita') recebido += e.valor;
    else if(e.tipo === 'despesa' && (e.forma === 'debito' || e.forma === 'dinheiro' || e.forma === 'pix')) saiu += e.valor;
  });
  // faturas pagas neste mês contam como "saiu"
  STATE.entries.filter(e=>e.tipo==='fatura_paga' && monthKey(e.data)===mk).forEach(e=> saiu += e.valor );
  return { recebido, saiu, saldo: recebido - saiu };
}

function faturaAbertaTotal(accountId, mk){
  // compras no crédito daquele mês/cartão que ainda não foram marcadas como pagas
  return STATE.entries
    .filter(e => e.tipo==='despesa' && (e.forma==='credito'||e.forma==='credito_parcelado')
      && e.conta===accountId && monthKey(e.data)===mk && !e.faturaPagaId)
    .reduce((s,e)=>s+e.valor,0);
}

function gastosVariaveisDoMes(mk){
  // despesas do mês que NÃO são gasto fixo lançado
  return entriesOfMonth(mk).filter(e=>e.tipo==='despesa' && !e.gastoFixoId).reduce((s,e)=>s+e.valor,0);
}
function gastosFixosLancadosDoMes(mk){
  return entriesOfMonth(mk).filter(e=>e.tipo==='despesa' && e.gastoFixoId).reduce((s,e)=>s+e.valor,0);
}
function entradaFixaDoMes(mk){
  return STATE.fixedIncomes.reduce((s,f)=>s+f.valor,0);
}
function entradasVariaveisDoMes(mk){
  return entriesOfMonth(mk).filter(e=>e.tipo==='receita' && !e.entradaFixaId).reduce((s,e)=>s+e.valor,0);
}
function aportesDoMes(mk){
  return STATE.investments.filter(i=>monthKey(i.data)===mk).reduce((s,i)=>s+i.valor,0);
}

function gastoPorCategoria(mk, tipo='despesa'){
  const map = {};
  entriesOfMonth(mk).filter(e=>e.tipo===tipo).forEach(e=>{
    map[e.categoria] = (map[e.categoria]||0) + e.valor;
  });
  return map;
}

// média dos últimos N meses (excluindo o mês corrente) por categoria
function mediaHistoricaPorCategoria(catId, mesesAtras=3){
  const now = new Date();
  let total=0, count=0;
  for(let i=1;i<=mesesAtras;i++){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const mk = d.toISOString().slice(0,7);
    const es = entriesOfMonth(mk).filter(e=>e.tipo==='despesa' && e.categoria===catId);
    if(es.length){ total += es.reduce((s,e)=>s+e.valor,0); count++; }
  }
  return count? total/count : null;
}

/* ===========================================================
   NAVEGAÇÃO / RENDER SHELL
=========================================================== */
const TABS = [
  { id:'lancamentos', label:'Lançar', icon:'✎' },
  { id:'faturas', label:'Faturas', icon:'▤' },
  { id:'graficos', label:'Gráficos', icon:'◔' },
  { id:'grupos', label:'Grupos', icon:'◈' },
  { id:'investim', label:'Investir', icon:'↗' },
  { id:'ajustes', label:'Ajustes', icon:'⚙' },
];
let currentTab = 'lancamentos';
let graficoPeriodo = 'mes'; // mes | 30 | 90 | ano

function renderTabbar(){
  const nav = document.getElementById('tabbar');
  nav.innerHTML = TABS.map(t=>`
    <button data-tab="${t.id}" class="${t.id===currentTab?'active':''}">
      <span class="ico">${t.icon}</span><span>${t.label}</span>
    </button>`).join('');
  nav.querySelectorAll('button').forEach(b=>{
    b.addEventListener('click', ()=>{ currentTab = b.dataset.tab; renderAll(); });
  });
}

function renderHeader(){
  const sub = document.getElementById('header-sub');
  const mk = currentMonthKey();
  sub.textContent = monthLabel(mk).replace(/^\w/, c=>c.toUpperCase());
}

function renderAll(){
  renderHeader();
  renderTabbar();
  const main = document.getElementById('main');
  if(currentTab==='lancamentos') main.innerHTML = viewLancamentos();
  if(currentTab==='faturas') main.innerHTML = viewFaturas();
  if(currentTab==='graficos') main.innerHTML = viewGraficos();
  if(currentTab==='grupos') main.innerHTML = viewGrupos();
  if(currentTab==='investim') main.innerHTML = viewInvestim();
  if(currentTab==='ajustes') main.innerHTML = viewAjustes();
  bindTabEvents();
}

function closeModal(){
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-content').innerHTML = '';
}
function openModal(html){
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}
document.getElementById('modal-overlay').addEventListener('click', (e)=>{
  if(e.target.id==='modal-overlay') closeModal();
});

function accountOptions(selected){
  return STATE.accounts.map(a=>`<option value="${a.id}" ${a.id===selected?'selected':''}>${a.nome}</option>`).join('');
}
function categoryOptions(selected){
  const sorted = [...STATE.categories].sort((a,b)=> (b.favorito-a.favorito));
  return sorted.map(c=>`<option value="${c.id}" ${c.id===selected?'selected':''}>${c.nome}</option>`).join('');
}

/* ===========================================================
   ABA: LANÇAMENTOS
=========================================================== */
let lancForm = { tipo:'despesa', forma:'debito', parcelas:1 };
let lancFiltro = 'tudo';
let lancBusca = '';

function viewLancamentos(){
  const mk = currentMonthKey();
  const es = entriesOfMonth(mk).concat(STATE.entries.filter(e=>e.tipo==='transferencia' && monthKey(e.data)===mk));
  let filtered = es;
  if(lancFiltro==='conta') filtered = es.filter(e=> e.tipo==='transferencia' || e.tipo==='receita' || (e.tipo==='despesa' && ['debito','dinheiro','pix'].includes(e.forma)));
  if(lancFiltro==='cartao') filtered = es.filter(e=> e.tipo==='despesa' && ['credito','credito_parcelado'].includes(e.forma));
  if(lancBusca.trim()) filtered = filtered.filter(e=> e.descricao.toLowerCase().includes(lancBusca.toLowerCase()));
  filtered = filtered.slice().sort((a,b)=> b.data.localeCompare(a.data) || (b.criadoEm||0)-(a.criadoEm||0));

  const entrouTotal = es.filter(e=>e.tipo==='receita').reduce((s,e)=>s+e.valor,0);
  const saiuTotal = es.filter(e=>e.tipo==='despesa'&&['debito','dinheiro','pix'].includes(e.forma)).reduce((s,e)=>s+e.valor,0);
  const cartaoTotal = es.filter(e=>e.tipo==='despesa'&&['credito','credito_parcelado'].includes(e.forma)).reduce((s,e)=>s+e.valor,0);

  let lastDate = null;
  const rows = filtered.map(e=>{
    let sep = '';
    if(e.data !== lastDate){ lastDate = e.data; sep = `<div class="date-sep">${fmtDate(e.data)}</div>`; }
    const barClass = e.tipo==='transferencia' ? 'azul' : e.tipo==='receita' ? 'verde' : (['credito','credito_parcelado'].includes(e.forma) ? 'amarelo' : 'cinza');
    const acc = accountById(e.conta);
    const cat = categoryById(e.categoria);
    const metaTxt = e.tipo==='transferencia' ? 'transferência entre contas' : [cat?cat.nome:'', acc?acc.nome:''].filter(Boolean).join(' · ');
    const sinal = e.tipo==='receita' ? '+' : e.tipo==='transferencia' ? '⇄' : '-';
    const valClass = e.tipo==='receita' ? 'pos' : e.tipo==='transferencia' ? 'neutral' : 'neg';
    return sep + `
    <div class="entry" data-id="${e.id}">
      <div class="bar ${barClass}"></div>
      <div class="info">
        <div class="desc-line">${e.descricao}${e.parcelaAtual?` (${e.parcelaAtual}/${e.totalParcelas})`:''}</div>
        <div class="meta-line">${metaTxt}</div>
      </div>
      <div class="val num ${valClass}">${sinal} ${fmtMoney(e.valor)}</div>
    </div>`;
  }).join('');

  return `
  <div class="card">
    <div class="row" style="margin-bottom:2px;">
      <h2 style="flex:2;">Novo lançamento</h2>
      <button class="chip" id="btn-transfer" style="flex:none;">⇄ transferir</button>
    </div>
    <div class="toggle2" id="tipo-toggle">
      <button data-v="despesa" class="${lancForm.tipo==='despesa'?'on despesa':''}">− Despesa</button>
      <button data-v="receita" class="${lancForm.tipo==='receita'?'on receita':''}">+ Receita</button>
    </div>
    <form id="form-lanc">
      <label>Descrição</label>
      <input type="text" name="descricao" placeholder="Ex: Mercado do mês" required />

      <div class="row">
        <div>
          <label>Conta / Cartão</label>
          <select name="conta">${accountOptions()}</select>
        </div>
        <div id="forma-wrap" style="${lancForm.tipo==='receita'?'display:none':''}">
          <label>Forma</label>
          <select name="forma" id="forma-select">
            <option value="debito">Débito</option>
            <option value="pix">Pix</option>
            <option value="dinheiro">Dinheiro</option>
            <option value="credito">Crédito</option>
            <option value="credito_parcelado">Crédito parcelado</option>
          </select>
        </div>
      </div>

      <div id="parcelas-wrap" style="display:none;">
        <label>Número de parcelas</label>
        <select name="parcelas">${Array.from({length:12},(_,i)=>i+2).map(n=>`<option value="${n}">${n}x</option>`).join('')}</select>
      </div>

      <div class="row">
        <div>
          <label>Categoria</label>
          <select name="categoria">${categoryOptions()}</select>
        </div>
        <div>
          <label>Data</label>
          <input type="date" name="data" value="${todayISO()}" />
        </div>
      </div>

      <label>Valor ${lancForm.forma==='credito_parcelado'?'(total)':''}</label>
      <input type="text" inputmode="decimal" name="valor" class="money" placeholder="R$ 0,00" required />

      <label style="display:flex;align-items:center;gap:6px;margin-top:12px;">
        <input type="checkbox" name="emprestimo" style="width:auto;" /> Emprestei para alguém
      </label>
      <div id="emprestimo-wrap" style="display:none;">
        <input type="text" name="devedor" placeholder="Nome de quem deve (separe por vírgula se for mais de um)" />
      </div>

      <button type="submit" class="btn" style="margin-top:14px;">Salvar lançamento</button>
    </form>
    <button class="btn ghost" id="btn-anexar-foto" style="margin-top:10px;">📷 Lançar por foto</button>
  </div>

  <div class="card">
    <h2>🔎 Consulta rápida</h2>
    <p class="desc">Pergunte sobre seus gastos deste mês.</p>
    <div class="row">
      <input type="text" id="consulta-input" placeholder='Ex: "onde gastei mais este mês"' />
      <button class="btn small" id="btn-consulta" style="flex:none;">Perguntar</button>
    </div>
    <div id="consulta-resp" style="margin-top:10px;font-size:13px;color:var(--text-dim);"></div>
  </div>

  <div class="card">
    <div class="row" style="align-items:center;">
      <h2 style="flex:1;">Lançamentos</h2>
    </div>
    <div class="chipbar">
      <div class="chip ${lancFiltro==='tudo'?'active':''}" data-f="tudo">Tudo</div>
      <div class="chip ${lancFiltro==='conta'?'active':''}" data-f="conta">Conta</div>
      <div class="chip ${lancFiltro==='cartao'?'active':''}" data-f="cartao">Cartão</div>
    </div>
    <p class="desc">entrou <span class="pos num">${fmtMoney(entrouTotal)}</span> · saiu <span class="neg num">${fmtMoney(saiuTotal)}</span> · cartão <span class="num" style="color:var(--amber)">${fmtMoney(cartaoTotal)}</span></p>
    <input type="text" class="search" id="lanc-search" placeholder="Buscar lançamentos..." value="${lancBusca}" />
    ${rows || '<div class="empty">Nada lançado ainda neste mês.</div>'}
  </div>`;
}

function parseMoney(str){
  if(typeof str === 'number') return str;
  const clean = String(str).replace(/[^\d,.-]/g,'').replace(/\.(?=\d{3},)/g,'').replace(',','.');
  return parseFloat(clean) || 0;
}

async function addEntry(e){
  const f = e.target;
  const fd = new FormData(f);
  const tipo = lancForm.tipo;
  const forma = tipo==='receita' ? null : fd.get('forma');
  const valorTotal = parseMoney(fd.get('valor'));
  const base = {
    descricao: fd.get('descricao'),
    conta: fd.get('conta'),
    categoria: fd.get('categoria'),
    data: fd.get('data') || todayISO(),
    criadoEm: Date.now(),
  };
  const emprestimo = fd.get('emprestimo') === 'on';
  const devedor = fd.get('devedor');

  if(forma === 'credito_parcelado'){
    const n = parseInt(fd.get('parcelas')||'2',10);
    const valorParcela = Math.round((valorTotal/n)*100)/100;
    const grupoId = uid();
    for(let i=0;i<n;i++){
      const d = new Date(base.data+'T00:00:00');
      d.setMonth(d.getMonth()+i);
      STATE.entries.push({
        id: uid(), tipo:'despesa', forma, valor: valorParcela,
        ...base, data: d.toISOString().slice(0,10),
        parcelaGrupo: grupoId, parcelaAtual: i+1, totalParcelas: n,
        devedor: emprestimo ? devedor : null
      });
    }
  } else {
    STATE.entries.push({
      id: uid(), tipo, forma, valor: valorTotal, ...base,
      devedor: emprestimo ? devedor : null
    });
  }
  await persist();
  showToast('Lançamento salvo');
  f.reset();
  renderAll();
}

function bindLancEvents(){
  const toggle = document.getElementById('tipo-toggle');
  if(toggle) toggle.querySelectorAll('button').forEach(b=>{
    b.addEventListener('click', ()=>{ lancForm.tipo = b.dataset.v; renderAll(); });
  });
  const formaSel = document.getElementById('forma-select');
  if(formaSel) formaSel.addEventListener('change', ()=>{
    document.getElementById('parcelas-wrap').style.display = formaSel.value==='credito_parcelado' ? 'block':'none';
  });
  const empChk = document.querySelector('input[name=emprestimo]');
  if(empChk) empChk.addEventListener('change', ()=>{
    document.getElementById('emprestimo-wrap').style.display = empChk.checked ? 'block':'none';
  });
  const form = document.getElementById('form-lanc');
  if(form) form.addEventListener('submit', (e)=>{ e.preventDefault(); addEntry(e); });

  document.querySelectorAll('#main .chip[data-f]').forEach(c=>{
    c.addEventListener('click', ()=>{ lancFiltro = c.dataset.f; renderAll(); });
  });
  const search = document.getElementById('lanc-search');
  if(search) search.addEventListener('input', ()=>{ lancBusca = search.value; renderLancList(); });

  document.querySelectorAll('.entry[data-id]').forEach(row=>{
    row.addEventListener('click', ()=> openEntryOptions(row.dataset.id));
  });

  const btnT = document.getElementById('btn-transfer');
  if(btnT) btnT.addEventListener('click', openTransferModal);

  const btnC = document.getElementById('btn-consulta');
  if(btnC) btnC.addEventListener('click', runConsulta);

  const btnFoto = document.getElementById('btn-anexar-foto');
  if(btnFoto) btnFoto.addEventListener('click', openAnexarModal);
}

function renderLancList(){
  // re-render só a lista pra não perder foco do input de busca a cada tecla
  const main = document.getElementById('main');
  main.innerHTML = viewLancamentos();
  bindLancEvents();
  document.getElementById('lanc-search').focus();
  document.getElementById('lanc-search').setSelectionRange(lancBusca.length, lancBusca.length);
}

function openEntryOptions(id){
  const e = STATE.entries.find(x=>x.id===id);
  if(!e) return;
  openModal(`
    <div class="modal-head"><h3>${e.descricao}</h3><button class="x" onclick="closeModal()">×</button></div>
    <p class="desc">${fmtDate(e.data)} · ${fmtMoney(e.valor)}</p>
    <button class="btn secondary" style="margin-bottom:8px;" onclick="closeModal()">Editar</button>
    <button class="btn danger" onclick="deleteEntry('${id}')">Excluir</button>
  `);
}
async function deleteEntry(id){
  STATE.entries = STATE.entries.filter(e=>e.id!==id);
  await persist();
  closeModal();
  renderAll();
}

function openTransferModal(){
  openModal(`
    <div class="modal-head"><h3>Transferência</h3><button class="x" onclick="closeModal()">×</button></div>
    <p class="desc">Não entra nas receitas/despesas — só dinheiro mudando de conta.</p>
    <form id="form-transfer">
      <label>De</label><select name="de">${accountOptions()}</select>
      <label>Para</label><select name="para">${accountOptions()}</select>
      <label>Valor</label><input type="text" inputmode="decimal" name="valor" placeholder="R$ 0,00" required />
      <label>Data</label><input type="date" name="data" value="${todayISO()}" />
      <button type="submit" class="btn" style="margin-top:14px;">Transferir</button>
    </form>`);
  document.getElementById('form-transfer').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    STATE.entries.push({
      id: uid(), tipo:'transferencia', valor: parseMoney(fd.get('valor')),
      descricao: 'Transferência', contaOrigem: fd.get('de'), conta: fd.get('para'),
      data: fd.get('data')||todayISO(), criadoEm: Date.now()
    });
    await persist();
    closeModal();
    renderAll();
  });
}

function runConsulta(){
  const q = document.getElementById('consulta-input').value.toLowerCase();
  const mk = currentMonthKey();
  const catMap = gastoPorCategoria(mk);
  const respEl = document.getElementById('consulta-resp');
  if(!q.trim()){ respEl.textContent = 'Digite uma pergunta.'; return; }
  if(q.includes('onde gastei') || q.includes('maior gasto') || q.includes('gastei mais')){
    const entries = Object.entries(catMap).sort((a,b)=>b[1]-a[1]);
    if(!entries.length){ respEl.textContent = 'Ainda não há gastos lançados este mês.'; return; }
    const total = entries.reduce((s,[,v])=>s+v,0);
    respEl.innerHTML = `Gastou ${fmtMoney(total)} em ${monthLabel(mk)}:<br>` +
      entries.slice(0,5).map(([cid,v])=>{
        const c = categoryById(cid);
        return `• ${c?c.nome:'—'}: ${fmtMoney(v)} (${Math.round(v/total*100)}%)`;
      }).join('<br>');
    return;
  }
  if(q.includes('quem me deve')){
    const devedores = {};
    STATE.entries.filter(e=>e.devedor && e.tipo==='despesa').forEach(e=>{
      e.devedor.split(',').map(s=>s.trim()).filter(Boolean).forEach(n=>{
        devedores[n] = (devedores[n]||0) + e.valor;
      });
    });
    const list = Object.entries(devedores);
    respEl.innerHTML = list.length ? list.map(([n,v])=>`• ${n}: ${fmtMoney(v)}`).join('<br>') : 'Ninguém te deve nada registrado.';
    return;
  }
  if(q.includes('sobrou') || q.includes('saldo')){
    const {saldo} = saldoDoMes(mk);
    respEl.textContent = `Saldo do mês: ${fmtMoney(saldo)}.`;
    return;
  }
  respEl.textContent = 'Ainda não sei responder isso — tente "onde gastei mais este mês", "quem me deve" ou "quanto sobrou".';
}

/* ===========================================================
   ABA: FATURAS  (Resumo, Entradas+Orientador, Fatura cartão, Fixos, Empréstimos)
=========================================================== */
function viewFaturas(){
  const mk = currentMonthKey();
  const { recebido, saiu, saldo } = saldoDoMes(mk);
  const cartoes = STATE.accounts.filter(a=>a.credito);
  const faturaAbertaTotal_ = cartoes.reduce((s,a)=> s + faturaAbertaTotal(a.id, mk), 0);

  return `
  <div class="card">
    <h2>Resumo — ${monthLabel(mk)}</h2>
    <div class="grid2" style="margin-top:10px;">
      <div class="stat">
        <div class="label">SALDO DO MÊS</div>
        <div class="val ${saldo>=0?'pos':'neg'}">${fmtMoney(saldo)}</div>
      </div>
      <div class="stat">
        <div class="label">FATURA EM ABERTO</div>
        <div class="val" style="color:var(--amber)">${fmtMoney(faturaAbertaTotal_)}</div>
      </div>
      <div class="stat">
        <div class="label">RECEBIDO</div>
        <div class="val pos">${fmtMoney(recebido)}</div>
      </div>
      <div class="stat">
        <div class="label">SAIU DA CONTA</div>
        <div class="val neg">${fmtMoney(saiu)}</div>
      </div>
    </div>
  </div>

  ${viewEntradasCard(mk)}
  ${viewOrientadorCard(mk)}
  ${viewFaturaCartaoCard(mk)}
  ${viewGastosFixosCard(mk)}
  ${viewEmprestimosCard()}
  `;
}

/* ---- Entradas ---- */
function viewEntradasCard(mk){
  const fixa = entradaFixaDoMes(mk);
  const variaveis = entradasVariaveisDoMes(mk);
  const fixosLancados = gastosFixosLancadosDoMes(mk);
  const varGastos = gastosVariaveisDoMes(mk);
  const totalEntrou = fixa + variaveis;
  const totalGasto = fixosLancados + varGastos;
  const resultado = totalEntrou - totalGasto;

  const rows = STATE.fixedIncomes.map(f=>`
    <div class="fixedline">
      <div><div class="name">${f.descricao}</div><div class="sub">todo dia ${f.dia}</div></div>
      <div class="val num">${fmtMoney(f.valor)}</div>
    </div>`).join('');

  return `
  <div class="card">
    <h2>Entradas</h2>
    <p class="desc">Salário e outras entradas fixas do mês.</p>
    ${rows || '<p class="empty">Nenhuma entrada fixa cadastrada.</p>'}
    <button class="btn ghost" id="btn-nova-entrada-fixa" style="margin-top:8px;">+ nova entrada fixa</button>

    <div class="grid3" style="margin-top:14px;">
      <div class="stat"><div class="label">ENTRADA FIXA</div><div class="val pos">${fmtMoney(fixa)}</div></div>
      <div class="stat"><div class="label">GASTOS FIXOS</div><div class="val neg">${fmtMoney(fixosLancados)}</div></div>
      <div class="stat"><div class="label">VARIÁVEIS</div><div class="val neg">${fmtMoney(varGastos)}</div></div>
    </div>
    <p class="desc" style="margin-top:10px;">Resultado do mês: <span class="num ${resultado>=0?'pos':'neg'}" style="font-weight:600;">${fmtMoney(resultado)}</span></p>
  </div>`;
}

function openNovaEntradaFixaModal(){
  openModal(`
    <div class="modal-head"><h3>Nova entrada fixa</h3><button class="x" onclick="closeModal()">×</button></div>
    <form id="form-entrada-fixa">
      <label>Descrição</label><input type="text" name="descricao" placeholder="Ex: Salário" required />
      <label>Valor mensal</label><input type="text" inputmode="decimal" name="valor" placeholder="R$ 0,00" required />
      <label>Todo dia</label><input type="number" name="dia" min="1" max="31" value="5" />
      <button type="submit" class="btn" style="margin-top:14px;">Salvar</button>
    </form>`);
  document.getElementById('form-entrada-fixa').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    STATE.fixedIncomes.push({ id: uid(), descricao: fd.get('descricao'), valor: parseMoney(fd.get('valor')), dia: parseInt(fd.get('dia')||'5',10) });
    await persist(); closeModal(); renderAll();
  });
}

/* ---- Orientador financeiro (meta de 15%) ---- */
function viewOrientadorCard(mk){
  const fixa = entradaFixaDoMes(mk);
  const pct = STATE.settings.poupancaMetaPct;
  const metaValor = fixa * (pct/100);
  const { saldo: sobraCaixa } = saldoDoMes(mk);
  const aportado = aportesDoMes(mk);
  const progresso = metaValor>0 ? Math.min(100, Math.round((aportado/metaValor)*100)) : 0;

  if(fixa === 0){
    return `<div class="card"><h2>Orientador financeiro</h2><p class="desc">Cadastre sua entrada fixa acima pra eu calcular sua meta de poupança (${pct}%) e começar a te orientar.</p></div>`;
  }

  // categorias flexíveis que mais fugiram da média
  const gastosCat = gastoPorCategoria(mk);
  const desvios = STATE.categories.filter(c=>!c.essencial).map(c=>{
    const atual = gastosCat[c.id]||0;
    const media = mediaHistoricaPorCategoria(c.id);
    const desvio = media!==null ? atual - media : null;
    return { cat:c, atual, media, desvio };
  }).filter(d=> d.desvio!==null && d.desvio > 0).sort((a,b)=>b.desvio-a.desvio);

  let orientLines = '';
  if(sobraCaixa - aportado > 0 && aportado < metaValor){
    orientLines += `<div class="orient-line"><div class="dot"></div><div>Você tem ${fmtMoney(sobraCaixa - aportado)} de sobra que ainda não virou aporte. Guardar isso bate parte da sua meta de ${pct}%.</div></div>`;
  }
  if(desvios.length){
    const top = desvios[0];
    orientLines += `<div class="orient-line"><div class="dot"></div><div>Maior vilão do mês: <b>${top.cat.nome}</b>, ${fmtMoney(top.desvio)} acima da sua média. Cortando isso, fica mais fácil bater a meta no mês que vem.</div></div>`;
  } else {
    orientLines += `<div class="orient-line"><div class="dot"></div><div>Nenhuma categoria flexível fugiu muito da sua média este mês. Bom sinal.</div></div>`;
  }
  if(progresso >= 100){
    orientLines += `<div class="orient-line"><div class="dot" style="background:var(--accent)"></div><div>Meta de ${pct}% batida este mês. 🎉</div></div>`;
  }

  return `
  <div class="card">
    <h2>Orientador financeiro</h2>
    <p class="desc">Meta: guardar ${pct}% da sua entrada fixa = <span class="num" style="color:var(--text)">${fmtMoney(metaValor)}</span></p>
    <div class="catbar-wrap">
      <div class="catbar-head"><span>Guardado (aportado)</span><span class="num">${fmtMoney(aportado)} de ${fmtMoney(metaValor)}</span></div>
      <div class="catbar-track"><div class="catbar-fill under" style="width:${progresso}%"></div></div>
    </div>
    ${orientLines}
  </div>`;
}

/* ---- Fatura do cartão ---- */
function viewFaturaCartaoCard(mk){
  const cartoes = STATE.accounts.filter(a=>a.credito);
  if(!cartoes.length) return `<div class="card"><h2>Fatura do cartão</h2><p class="desc">Nenhum cartão de crédito cadastrado ainda. Adicione um em Ajustes.</p></div>`;
  const blocks = cartoes.map(a=>{
    const total = faturaAbertaTotal(a.id, mk);
    const compras = STATE.entries.filter(e=>e.tipo==='despesa' && e.conta===a.id && ['credito','credito_parcelado'].includes(e.forma) && monthKey(e.data)===mk && !e.faturaPagaId);
    return `
    <div class="fixedline">
      <div><div class="name">${a.nome} <span class="sub">▸</span></div><div class="sub">${compras.length} compras · vence dia ${a.vencimento||'—'}</div></div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="val num neg">${fmtMoney(total)}</span>
        <button class="btn small secondary" data-pagar="${a.id}">pagar</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="card"><h2>Fatura do cartão</h2><p class="desc">Marque o que já pagou. Se o valor do banco não bater, a diferença vira um lançamento de ajuste.</p>${blocks}</div>`;
}

function openPagarFaturaModal(accountId){
  const mk = currentMonthKey();
  const total = faturaAbertaTotal(accountId, mk);
  const acc = accountById(accountId);
  openModal(`
    <div class="modal-head"><h3>Pagar fatura — ${acc.nome}</h3><button class="x" onclick="closeModal()">×</button></div>
    <p class="desc">Somado aqui no app: <b class="num">${fmtMoney(total)}</b></p>
    <form id="form-pagar-fatura">
      <label>Valor que o banco cobrou</label>
      <input type="text" inputmode="decimal" name="valor" value="${total.toFixed(2).replace('.',',')}" required />
      <label>Pago em</label><input type="date" name="data" value="${todayISO()}" />
      <button type="submit" class="btn" style="margin-top:14px;">Confirmar pagamento</button>
    </form>`);
  document.getElementById('form-pagar-fatura').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const valorBanco = parseMoney(fd.get('valor'));
    const faturaId = uid();
    STATE.entries.filter(en=>en.tipo==='despesa' && en.conta===accountId && ['credito','credito_parcelado'].includes(en.forma) && monthKey(en.data)===mk && !en.faturaPagaId)
      .forEach(en=> en.faturaPagaId = faturaId );
    const diff = Math.round((valorBanco-total)*100)/100;
    STATE.entries.push({ id: uid(), tipo:'fatura_paga', valor: valorBanco, descricao:`Fatura ${acc.nome}`, conta:accountId, categoria:null, data: fd.get('data')||todayISO(), criadoEm: Date.now(), faturaPagaId: faturaId });
    if(Math.abs(diff) > 0.009){
      STATE.entries.push({ id: uid(), tipo:'despesa', forma:'debito', valor: Math.abs(diff), descricao:'Ajuste de fatura — não identificado', conta:accountId, categoria: STATE.categories.find(c=>c.nome==='Outros')?.id || STATE.categories[0].id, data: fd.get('data')||todayISO(), criadoEm: Date.now() });
    }
    await persist(); closeModal(); renderAll();
    showToast('Fatura paga registrada');
  });
}

/* ---- Gastos fixos ---- */
function viewGastosFixosCard(mk){
  const rows = STATE.fixedExpenses.map(f=>{
    const lancado = entriesOfMonth(mk).some(e=>e.gastoFixoId===f.id);
    const acc = accountById(f.conta);
    return `<div class="fixedline">
      <div><div class="name">${f.descricao}</div><div class="sub">${acc?acc.nome:''} · todo dia ${f.dia} · ${lancado?'lançado':'ainda não lançado'}</div></div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="val num neg">${fmtMoney(f.valor)}</span>
        ${!lancado?`<button class="btn small secondary" data-lancar-fixo="${f.id}">lançar</button>`:''}
      </div>
    </div>`;
  }).join('');
  const total = STATE.fixedExpenses.reduce((s,f)=>s+f.valor,0);
  return `<div class="card">
    <h2>Gastos fixos mensais</h2>
    <p class="desc">Total por mês: <b class="num">${fmtMoney(total)}</b></p>
    ${rows || '<p class="empty">Nenhum gasto fixo cadastrado.</p>'}
    <button class="btn ghost" id="btn-novo-fixo" style="margin-top:8px;">+ novo gasto fixo</button>
  </div>`;
}

function openNovoFixoModal(){
  openModal(`
    <div class="modal-head"><h3>Novo gasto fixo</h3><button class="x" onclick="closeModal()">×</button></div>
    <form id="form-fixo">
      <label>Descrição</label><input type="text" name="descricao" required />
      <label>Valor mensal</label><input type="text" inputmode="decimal" name="valor" required />
      <label>Todo dia</label><input type="number" name="dia" min="1" max="31" value="5" />
      <label>Conta / Cartão</label><select name="conta">${accountOptions()}</select>
      <label>Categoria</label><select name="categoria">${categoryOptions()}</select>
      <button type="submit" class="btn" style="margin-top:14px;">Salvar gasto fixo</button>
    </form>`);
  document.getElementById('form-fixo').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    STATE.fixedExpenses.push({ id: uid(), descricao: fd.get('descricao'), valor: parseMoney(fd.get('valor')), dia: parseInt(fd.get('dia')||'5',10), conta: fd.get('conta'), categoria: fd.get('categoria') });
    await persist(); closeModal(); renderAll();
  });
}
async function lancarFixo(fixoId){
  const f = STATE.fixedExpenses.find(x=>x.id===fixoId);
  if(!f) return;
  const acc = accountById(f.conta);
  STATE.entries.push({
    id: uid(), tipo:'despesa', forma: acc.credito?'credito':'debito', valor: f.valor,
    descricao: f.descricao, conta: f.conta, categoria: f.categoria, data: todayISO(),
    criadoEm: Date.now(), gastoFixoId: f.id
  });
  await persist(); renderAll(); showToast('Gasto fixo lançado');
}

/* ---- Empréstimos ---- */
function viewEmprestimosCard(){
  const porPessoa = {};
  STATE.entries.filter(e=>e.devedor && e.tipo==='despesa').forEach(e=>{
    e.devedor.split(',').map(s=>s.trim()).filter(Boolean).forEach(nome=>{
      if(!porPessoa[nome]) porPessoa[nome] = [];
      porPessoa[nome].push(e);
    });
  });
  const nomes = Object.keys(porPessoa);
  const total = nomes.reduce((s,n)=> s + porPessoa[n].reduce((s2,e)=>s2+e.valor/(e.devedor.split(',').length),0), 0);
  const rows = nomes.map(n=>{
    const soma = porPessoa[n].reduce((s,e)=>s+e.valor/(e.devedor.split(',').length),0);
    return `<div class="fixedline"><div class="name">${n}</div><div class="val num" style="color:var(--amber)">${fmtMoney(soma)}</div></div>`;
  }).join('');
  return `<div class="card">
    <h2>Empréstimos</h2>
    <p class="desc">O que te devem, agrupado por pessoa.</p>
    <p class="desc">Total a receber: <b class="num pos">${fmtMoney(total)}</b></p>
    ${rows || '<p class="empty">Ninguém te deve nada registrado.</p>'}
  </div>`;
}

function bindFaturasEvents(){
  const b1 = document.getElementById('btn-nova-entrada-fixa'); if(b1) b1.addEventListener('click', openNovaEntradaFixaModal);
  const b2 = document.getElementById('btn-novo-fixo'); if(b2) b2.addEventListener('click', openNovoFixoModal);
  document.querySelectorAll('[data-pagar]').forEach(b=> b.addEventListener('click', ()=>openPagarFaturaModal(b.dataset.pagar)));
  document.querySelectorAll('[data-lancar-fixo]').forEach(b=> b.addEventListener('click', ()=>lancarFixo(b.dataset.lancarFixo)));
}

/* ===========================================================
   ABA: GRÁFICOS
=========================================================== */
function periodoRange(periodo){
  const now = new Date();
  if(periodo==='mes') return [currentMonthKey()];
  if(periodo==='30' || periodo==='90'){
    const dias = periodo==='30'?30:90;
    const set = new Set();
    for(let i=0;i<dias;i+=30){
      const d = new Date(now); d.setDate(d.getDate()-i);
      set.add(d.toISOString().slice(0,7));
    }
    return [...set];
  }
  if(periodo==='ano'){
    const arr=[]; for(let m=0;m<12;m++){ const d=new Date(now.getFullYear(),m,1); if(d<=now) arr.push(d.toISOString().slice(0,7)); }
    return arr;
  }
  return [currentMonthKey()];
}

function viewGraficos(){
  const meses = periodoRange(graficoPeriodo);
  const catTotals = {};
  let despesaTotal=0, receitaTotal=0;
  meses.forEach(mk=>{
    entriesOfMonth(mk).forEach(e=>{
      if(e.tipo==='despesa'){ catTotals[e.categoria]=(catTotals[e.categoria]||0)+e.valor; despesaTotal+=e.valor; }
      if(e.tipo==='receita') receitaTotal += e.valor;
    });
  });
  const maxCat = Math.max(1, ...Object.values(catTotals));
  const catRows = STATE.categories
    .map(c=>({c, v: catTotals[c.id]||0}))
    .filter(x=>x.v>0)
    .sort((a,b)=>b.v-a.v)
    .map(({c,v})=>{
      const goal = STATE.goals[c.id];
      const pctOfMax = Math.round((v/maxCat)*100);
      const overGoal = goal && v>goal;
      let goalMarker = '';
      if(goal){
        const goalPos = Math.min(100, Math.round((goal/maxCat)*100));
        goalMarker = `<div class="goal-marker" style="left:${goalPos}%"></div>`;
      }
      return `
      <div class="catbar-wrap">
        <div class="catbar-head">
          <span>${c.nome}${goal?` <span style="color:var(--text-faint)">meta ${fmtMoney(goal)}</span>`:''}</span>
          <span class="num">${fmtMoney(v)} · ${Math.round(v/(despesaTotal||1)*100)}%</span>
        </div>
        <div class="catbar-track">
          <div class="catbar-fill ${overGoal?'':'under'}" style="width:${pctOfMax}%"></div>
          ${goalMarker}
        </div>
      </div>`;
    }).join('');

  return `
  <div class="card">
    <h2>Período</h2>
    <div class="chipbar">
      <div class="chip ${graficoPeriodo==='mes'?'active':''}" data-p="mes">Este mês</div>
      <div class="chip ${graficoPeriodo==='30'?'active':''}" data-p="30">30 dias</div>
      <div class="chip ${graficoPeriodo==='90'?'active':''}" data-p="90">90 dias</div>
      <div class="chip ${graficoPeriodo==='ano'?'active':''}" data-p="ano">Este ano</div>
    </div>
    <div class="grid3">
      <div class="stat"><div class="label">RECEITAS</div><div class="val pos">${fmtMoney(receitaTotal)}</div></div>
      <div class="stat"><div class="label">GASTOS</div><div class="val neg">${fmtMoney(despesaTotal)}</div></div>
      <div class="stat"><div class="label">RESULTADO</div><div class="val ${receitaTotal-despesaTotal>=0?'pos':'neg'}">${fmtMoney(receitaTotal-despesaTotal)}</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Gastos por categoria</h2>
    ${catRows || '<p class="empty">Sem gastos no período.</p>'}
  </div>

  <div class="card">
    <h2>Metas por categoria</h2>
    <p class="desc">Defina um teto mensal — a linha aparece no gráfico acima.</p>
    ${STATE.categories.map(c=>`
      <div class="fixedline">
        <div class="name">${c.nome}</div>
        <input type="text" inputmode="decimal" style="width:110px;text-align:right;" data-goal="${c.id}" placeholder="sem meta" value="${STATE.goals[c.id]?STATE.goals[c.id]:''}" />
      </div>`).join('')}
  </div>`;
}

function bindGraficosEvents(){
  document.querySelectorAll('#main .chip[data-p]').forEach(c=>{
    c.addEventListener('click', ()=>{ graficoPeriodo = c.dataset.p; renderAll(); });
  });
  document.querySelectorAll('[data-goal]').forEach(inp=>{
    inp.addEventListener('change', async ()=>{
      const v = parseMoney(inp.value);
      if(v>0) STATE.goals[inp.dataset.goal] = v; else delete STATE.goals[inp.dataset.goal];
      await persist(); renderAll();
    });
  });
}

/* ===========================================================
   ABA: GRUPOS
=========================================================== */
function viewGrupos(){
  const rows = STATE.groups.map(g=>{
    const total = STATE.entries.filter(e=>e.grupo===g.id && e.tipo==='despesa').reduce((s,e)=>s+e.valor,0);
    return `<div class="fixedline">
      <div><div class="name">${g.nome}</div><div class="sub">${g.encerrado?'encerrado':'em aberto'}</div></div>
      <div class="val num neg">${fmtMoney(total)}</div>
    </div>`;
  }).join('');
  return `<div class="card">
    <h2>Grupos de gastos</h2>
    <p class="desc">Viagens, rolês, shows — junte os gastos e veja o total.</p>
    ${rows || '<p class="empty">Nenhum grupo criado ainda.</p>'}
    <button class="btn ghost" id="btn-novo-grupo" style="margin-top:8px;">+ novo grupo</button>
  </div>`;
}
function bindGruposEvents(){
  const b = document.getElementById('btn-novo-grupo');
  if(b) b.addEventListener('click', ()=>{
    openModal(`<div class="modal-head"><h3>Novo grupo</h3><button class="x" onclick="closeModal()">×</button></div>
      <form id="form-grupo"><label>Nome do grupo</label><input type="text" name="nome" required />
      <button type="submit" class="btn" style="margin-top:14px;">Criar</button></form>`);
    document.getElementById('form-grupo').addEventListener('submit', async e=>{
      e.preventDefault();
      STATE.groups.push({ id: uid(), nome: new FormData(e.target).get('nome'), encerrado:false });
      await persist(); closeModal(); renderAll();
    });
  });
}

/* ===========================================================
   ABA: INVESTIMENTOS
=========================================================== */
function viewInvestim(){
  const total = STATE.investments.reduce((s,i)=>s+i.valor,0);
  const rows = STATE.investmentTypes.map(t=>{
    const soma = STATE.investments.filter(i=>i.tipo===t.id).reduce((s,i)=>s+i.valor,0);
    return `<div class="fixedline"><div class="name">${t.nome}</div><div class="val num pos">${fmtMoney(soma)}</div></div>`;
  }).join('');
  return `
  <div class="card">
    <h2>Total aportado</h2>
    <div class="num-lg pos">${fmtMoney(total)}</div>
  </div>
  <div class="card">
    <h2>Por tipo de ativo</h2>
    ${rows || '<p class="empty">Nenhum tipo cadastrado.</p>'}
    <button class="btn ghost" id="btn-novo-aporte" style="margin-top:8px;">+ novo aporte</button>
  </div>`;
}
function bindInvestimEvents(){
  const b = document.getElementById('btn-novo-aporte');
  if(b) b.addEventListener('click', ()=>{
    openModal(`<div class="modal-head"><h3>Novo aporte</h3><button class="x" onclick="closeModal()">×</button></div>
      <form id="form-aporte">
        <label>Valor</label><input type="text" inputmode="decimal" name="valor" required />
        <label>Tipo de ativo</label><select name="tipo">${STATE.investmentTypes.map(t=>`<option value="${t.id}">${t.nome}</option>`).join('')}</select>
        <label>Data</label><input type="date" name="data" value="${todayISO()}" />
        <button type="submit" class="btn" style="margin-top:14px;">Confirmar aporte</button>
      </form>`);
    document.getElementById('form-aporte').addEventListener('submit', async e=>{
      e.preventDefault();
      const fd = new FormData(e.target);
      STATE.investments.push({ id: uid(), valor: parseMoney(fd.get('valor')), tipo: fd.get('tipo'), data: fd.get('data')||todayISO() });
      await persist(); closeModal(); renderAll();
    });
  });
}

/* ===========================================================
   ABA: AJUSTES
=========================================================== */
function viewAjustes(){
  const accRows = STATE.accounts.map(a=>`
    <div class="fixedline">
      <div><div class="name">${a.favorito?'★ ':''}${a.nome}</div><div class="sub">${a.credito?`crédito · fecha dia ${a.fechamento||'—'} · vence dia ${a.vencimento||'—'}`:'sem crédito'}</div></div>
      <button class="btn small secondary" data-del-acc="${a.id}">excluir</button>
    </div>`).join('');
  const catRows = STATE.categories.map(c=>`
    <div class="fixedline">
      <div class="name">${c.favorito?'★ ':''}${c.nome}</div>
      <div style="display:flex;align-items:center;gap:10px;">
        <label style="display:flex;align-items:center;gap:4px;font-size:11.5px;margin:0;color:var(--text-dim);">
          <input type="checkbox" data-essencial="${c.id}" ${c.essencial?'checked':''} style="width:auto;" /> essencial
        </label>
        <button class="btn small secondary" data-del-cat="${c.id}">excluir</button>
      </div>
    </div>`).join('');

  return `
  <div class="card">
    <h2>Contas e cartões</h2>
    ${accRows}
    <button class="btn ghost" id="btn-nova-conta" style="margin-top:8px;">+ nova conta</button>
  </div>

  <div class="card">
    <h2>Categorias</h2>
    <p class="desc">Marque "essencial" pra categoria não entrar nas sugestões de corte do orientador.</p>
    ${catRows}
    <button class="btn ghost" id="btn-nova-cat" style="margin-top:8px;">+ nova categoria</button>
  </div>

  <div class="card">
    <h2>Meta de poupança</h2>
    <label>Percentual da entrada fixa a guardar por mês</label>
    <input type="number" id="input-meta-pct" value="${STATE.settings.poupancaMetaPct}" min="1" max="100" />
  </div>

  <div class="card">
    <h2>Backup e restauração</h2>
    <p class="desc">Exporte um arquivo com tudo, ou restaure em outro aparelho.</p>
    <button class="btn secondary" id="btn-export" style="margin-bottom:8px;">Exportar backup</button>
    <label class="btn ghost" style="text-align:center;cursor:pointer;">
      Importar backup
      <input type="file" id="input-import" accept="application/json" style="display:none;" />
    </label>
  </div>
  `;
}

function bindAjustesEvents(){
  const b1 = document.getElementById('btn-nova-conta');
  if(b1) b1.addEventListener('click', ()=>{
    openModal(`<div class="modal-head"><h3>Nova conta</h3><button class="x" onclick="closeModal()">×</button></div>
    <form id="form-conta">
      <label>Nome da conta / cartão</label><input type="text" name="nome" required />
      <label style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" name="credito" id="chk-credito" style="width:auto;" /> Tem cartão de crédito
      </label>
      <div id="cred-fields" style="display:none;">
        <div class="row">
          <div><label>Fecha no dia</label><input type="number" name="fechamento" min="1" max="31" /></div>
          <div><label>Vence no dia</label><input type="number" name="vencimento" min="1" max="31" /></div>
        </div>
      </div>
      <button type="submit" class="btn" style="margin-top:14px;">Salvar conta</button>
    </form>`);
    document.getElementById('chk-credito').addEventListener('change', (e)=>{
      document.getElementById('cred-fields').style.display = e.target.checked?'block':'none';
    });
    document.getElementById('form-conta').addEventListener('submit', async e=>{
      e.preventDefault();
      const fd = new FormData(e.target);
      STATE.accounts.push({
        id: uid(), nome: fd.get('nome'), credito: fd.get('credito')==='on',
        fechamento: fd.get('fechamento')?parseInt(fd.get('fechamento'),10):null,
        vencimento: fd.get('vencimento')?parseInt(fd.get('vencimento'),10):null,
        favorito:false
      });
      await persist(); closeModal(); renderAll();
    });
  });

  document.querySelectorAll('[data-del-acc]').forEach(b=> b.addEventListener('click', async ()=>{
    STATE.accounts = STATE.accounts.filter(a=>a.id!==b.dataset.delAcc);
    await persist(); renderAll();
  }));

  const b2 = document.getElementById('btn-nova-cat');
  if(b2) b2.addEventListener('click', ()=>{
    openModal(`<div class="modal-head"><h3>Nova categoria</h3><button class="x" onclick="closeModal()">×</button></div>
    <form id="form-cat">
      <label>Nome</label><input type="text" name="nome" required />
      <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" name="essencial" style="width:auto;" checked/> Essencial</label>
      <button type="submit" class="btn" style="margin-top:14px;">Salvar categoria</button>
    </form>`);
    document.getElementById('form-cat').addEventListener('submit', async e=>{
      e.preventDefault();
      const fd = new FormData(e.target);
      STATE.categories.push({ id: uid(), nome: fd.get('nome'), essencial: fd.get('essencial')==='on', favorito:false });
      await persist(); closeModal(); renderAll();
    });
  });
  document.querySelectorAll('[data-del-cat]').forEach(b=> b.addEventListener('click', async ()=>{
    STATE.categories = STATE.categories.filter(c=>c.id!==b.dataset.delCat);
    await persist(); renderAll();
  }));
  document.querySelectorAll('[data-essencial]').forEach(chk=> chk.addEventListener('change', async ()=>{
    const c = categoryById(chk.dataset.essencial); c.essencial = chk.checked;
    await persist();
  }));

  const metaInput = document.getElementById('input-meta-pct');
  if(metaInput) metaInput.addEventListener('change', async ()=>{
    STATE.settings.poupancaMetaPct = parseInt(metaInput.value,10)||15;
    await persist(); renderAll();
  });

  const btnExport = document.getElementById('btn-export');
  if(btnExport) btnExport.addEventListener('click', ()=>{
    const blob = new Blob([JSON.stringify(STATE,null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `meufinanceiro-backup-${todayISO()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showToast('Backup exportado');
  });
  const inputImport = document.getElementById('input-import');
  if(inputImport) inputImport.addEventListener('change', async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    const text = await file.text();
    try{
      const parsed = JSON.parse(text);
      STATE = parsed;
      await persist();
      showToast('Backup restaurado');
      renderAll();
    }catch(err){ showToast('Arquivo inválido'); }
  });
}

/* ===========================================================
   LEITURA DE FOTO — OCR local (Tesseract.js), sem custo e sem chave.
   Roda inteiramente no navegador. Menos precisa que IA, por isso
   sempre mostra uma tela de conferência antes de salvar.
=========================================================== */
let tesseractWorkerPromise = null;
function getOcrWorker(){
  if(!tesseractWorkerPromise){
    tesseractWorkerPromise = (async ()=>{
      if(typeof Tesseract === 'undefined'){
        throw new Error('OCR_INDISPONIVEL');
      }
      return await Tesseract.createWorker('por');
    })();
  }
  return tesseractWorkerPromise;
}

async function ocrImageToText(file){
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(file);
  return data.text || '';
}

// --- Parsing heurístico do texto reconhecido ---
function parseValor(text){
  // procura padrões tipo "R$ 1.234,56" ou "1234,56" perto de "R$"
  const comSifrao = text.match(/R\$\s*([\d.]{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i);
  if(comSifrao) return parseMoney(comSifrao[1]);
  const soNumero = text.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
  if(soNumero) return parseMoney(soNumero[1]);
  return 0;
}
function parseData(text){
  const m = text.match(/(\d{2})[\/\.-](\d{2})[\/\.-](\d{2,4})/);
  if(!m) return null;
  let [_, d, mo, y] = m;
  if(y.length===2) y = '20'+y;
  const iso = `${y}-${mo}-${d}`;
  const test = new Date(iso+'T00:00:00');
  if(isNaN(test.getTime())) return null;
  return iso;
}
function parseDescricao(text, valorStr, dataStr){
  const linhas = text.split('\n').map(l=>l.trim()).filter(Boolean);
  for(const l of linhas){
    const semValor = l.replace(/R\$\s*[\d.,]+/gi,'').replace(/\d{2}[\/\.-]\d{2}[\/\.-]\d{2,4}/g,'').trim();
    // ignora linhas muito curtas, só números, ou palavras genéricas de comprovante
    if(semValor.length >= 4 && !/^[\d\s.,:-]+$/.test(semValor) &&
       !/comprovante|recibo|transa[çc][ãa]o|pix|valor|data|hor[áa]rio/i.test(semValor)){
      return semValor.slice(0,60);
    }
  }
  return 'Lançamento por foto';
}

async function handleFotoUnica(file){
  if(!file) return;
  const statusEl = document.getElementById('anexar-status');
  statusEl.textContent = 'Lendo a imagem (pode levar alguns segundos)...';
  try{
    const text = await ocrImageToText(file);
    const valor = parseValor(text);
    const data = parseData(text) || todayISO();
    const descricao = parseDescricao(text, valor, data);
    closeModal();
    openConfirmarLeituraModal({ descricao, valor, data, forma: 'pix' });
  }catch(e){
    console.error(e);
    if(e.message === 'OCR_INDISPONIVEL'){
      statusEl.textContent = 'A leitura de imagem não carregou (precisa de internet na primeira vez). Tente de novo ou lance manualmente.';
    } else {
      statusEl.textContent = 'Não consegui ler essa imagem com clareza. Confira se está nítida, ou lance manualmente.';
    }
  }
}

function openAnexarModal(){
  openModal(`
    <div class="modal-head"><h3>Ler foto</h3><button class="x" onclick="closeModal()">×</button></div>
    <p class="desc">Comprovante de Pix ou print da compra. A leitura roda no seu aparelho, sem custo — só confira os dados antes de salvar, porque OCR erra de vez em quando.</p>
    <button class="btn secondary" id="btn-foto-camera" style="margin-bottom:8px;">📷 Tirar foto agora</button>
    <button class="btn ghost" id="btn-foto-galeria" style="margin-bottom:14px;">🖼 Anexar da galeria</button>
    <input type="file" id="input-foto-camera" accept="image/*" capture="environment" style="display:none;" />
    <input type="file" id="input-foto-galeria" accept="image/*" style="display:none;" />
    <hr style="border:none;border-top:1px solid var(--line);margin:6px 0 14px;" />
    <p class="desc">Tem um extrato inteiro, com vários lançamentos numa foto só?</p>
    <button class="btn ghost" id="btn-extrato">Ler extrato completo (vários lançamentos)</button>
    <div id="anexar-status" style="margin-top:12px;font-size:13px;color:var(--text-dim);"></div>
  `);
  const camIn = document.getElementById('input-foto-camera');
  const galIn = document.getElementById('input-foto-galeria');
  document.getElementById('btn-foto-camera').addEventListener('click', ()=>camIn.click());
  document.getElementById('btn-foto-galeria').addEventListener('click', ()=>galIn.click());
  camIn.addEventListener('change', (e)=> handleFotoUnica(e.target.files[0]));
  galIn.addEventListener('change', (e)=> handleFotoUnica(e.target.files[0]));
  document.getElementById('btn-extrato').addEventListener('click', openExtratoPicker);
}

function openConfirmarLeituraModal(info){
  openModal(`
    <div class="modal-head"><h3>Confira o lançamento</h3><button class="x" onclick="closeModal()">×</button></div>
    <p class="desc">Isso é o que consegui ler da imagem. Ajuste o que precisar antes de salvar — a leitura automática não é perfeita.</p>
    <form id="form-confirma-foto">
      <label>Descrição</label><input type="text" name="descricao" value="${(info.descricao||'').replace(/"/g,'')}" required />
      <div class="row">
        <div><label>Conta / Cartão</label><select name="conta">${accountOptions()}</select></div>
        <div><label>Forma</label>
          <select name="forma">
            <option value="pix" ${info.forma==='pix'?'selected':''}>Pix</option>
            <option value="debito" ${info.forma==='debito'?'selected':''}>Débito</option>
            <option value="credito" ${info.forma==='credito'?'selected':''}>Crédito</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div><label>Categoria</label><select name="categoria">${categoryOptions()}</select></div>
        <div><label>Data</label><input type="date" name="data" value="${info.data||todayISO()}" /></div>
      </div>
      <label>Valor</label>
      <input type="text" inputmode="decimal" name="valor" value="${(info.valor||0).toFixed(2).replace('.',',')}" required />
      <button type="submit" class="btn" style="margin-top:14px;">Salvar lançamento</button>
    </form>
  `);
  document.getElementById('form-confirma-foto').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    STATE.entries.push({
      id: uid(), tipo:'despesa', forma: fd.get('forma'), valor: parseMoney(fd.get('valor')),
      descricao: fd.get('descricao'), conta: fd.get('conta'), categoria: fd.get('categoria'),
      data: fd.get('data')||todayISO(), criadoEm: Date.now()
    });
    await persist();
    closeModal();
    renderAll();
    showToast('Lançamento salvo a partir da foto');
  });
}

function openExtratoPicker(){
  openModal(`
    <div class="modal-head"><h3>Ler extrato completo</h3><button class="x" onclick="closeModal()">×</button></div>
    <p class="desc">Anexe o print do extrato ou fatura com vários lançamentos, um abaixo do outro.</p>
    <button class="btn secondary" id="btn-extrato-camera" style="margin-bottom:8px;">📷 Tirar foto agora</button>
    <button class="btn ghost" id="btn-extrato-galeria">🖼 Anexar da galeria</button>
    <input type="file" id="input-extrato-camera" accept="image/*" capture="environment" style="display:none;" />
    <input type="file" id="input-extrato-galeria" accept="image/*" style="display:none;" />
    <div id="extrato-status" style="margin-top:12px;font-size:13px;color:var(--text-dim);"></div>
  `);
  const camIn = document.getElementById('input-extrato-camera');
  const galIn = document.getElementById('input-extrato-galeria');
  document.getElementById('btn-extrato-camera').addEventListener('click', ()=>camIn.click());
  document.getElementById('btn-extrato-galeria').addEventListener('click', ()=>galIn.click());
  camIn.addEventListener('change', (e)=> handleExtrato(e.target.files[0]));
  galIn.addEventListener('change', (e)=> handleExtrato(e.target.files[0]));
}

// Extrai várias linhas de lançamento de um texto de extrato.
// Heurística: cada linha com um valor monetário vira um candidato a lançamento;
// data usa a última data encontrada nas linhas anteriores (extratos costumam
// agrupar por data, com a data não repetida em toda linha).
function parseExtratoLinhas(text){
  const linhasBrutas = text.split('\n').map(l=>l.trim()).filter(Boolean);
  const out = [];
  let dataAtual = todayISO();
  for(const l of linhasBrutas){
    const dataMatch = parseData(l);
    if(dataMatch) dataAtual = dataMatch;
    const valorMatch = l.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
    if(!valorMatch) continue;
    const valor = parseMoney(valorMatch[1]);
    if(valor <= 0) continue;
    let descricao = l.replace(valorMatch[0],'').replace(/\d{2}[\/\.-]\d{2}[\/\.-]\d{2,4}/g,'').replace(/[-–—]\s*$/,'').trim();
    if(descricao.length < 3) descricao = 'Lançamento do extrato';
    out.push({ descricao: descricao.slice(0,60), valor, data: dataAtual });
  }
  return out;
}

async function handleExtrato(file){
  if(!file) return;
  const statusEl = document.getElementById('extrato-status');
  statusEl.textContent = 'Lendo o extrato (pode levar um tempinho)...';
  try{
    const text = await ocrImageToText(file);
    const linhas = parseExtratoLinhas(text);
    closeModal();
    if(!linhas.length){
      showToast('Não encontrei lançamentos nessa imagem — tente uma foto mais nítida.');
      return;
    }
    openExtratoPreviewModal(linhas);
  }catch(e){
    console.error(e);
    if(e.message === 'OCR_INDISPONIVEL'){
      statusEl.textContent = 'A leitura de imagem não carregou (precisa de internet na primeira vez). Tente de novo.';
    } else {
      statusEl.textContent = 'Não consegui ler esse extrato. Tente uma foto mais nítida ou lance manualmente.';
    }
  }
}

function pareceDuplicado(linha){
  return STATE.entries.some(e =>
    e.tipo==='despesa' && e.data===linha.data &&
    Math.abs(e.valor - linha.valor) < 0.01
  );
}

function openExtratoPreviewModal(linhas){
  const rows = linhas.map((l,i)=>{
    const dup = pareceDuplicado(l);
    return `
    <div class="fixedline" style="align-items:flex-start;">
      <label style="display:flex;gap:8px;flex:1;margin:0;">
        <input type="checkbox" data-idx="${i}" class="extrato-check" ${dup?'':'checked'} style="width:auto;margin-top:3px;" />
        <div style="flex:1;">
          <div class="name">${l.descricao} ${dup?'<span style="color:var(--amber);font-size:11px;">· parece já lançado</span>':''}</div>
          <div class="sub">${l.data}</div>
          <div class="row" style="margin-top:6px;">
            <select data-conta="${i}" style="font-size:12px;">${accountOptions()}</select>
            <select data-cat="${i}" style="font-size:12px;">${categoryOptions()}</select>
          </div>
        </div>
      </label>
      <div class="val num neg">${fmtMoney(l.valor)}</div>
    </div>`;
  }).join('');

  openModal(`
    <div class="modal-head"><h3>Conferir extrato</h3><button class="x" onclick="closeModal()">×</button></div>
    <p class="desc">${linhas.length} possíveis lançamentos encontrados. A leitura é heurística — confira valor e descrição de cada linha antes de importar.</p>
    <div style="max-height:50vh;overflow-y:auto;">${rows}</div>
    <button class="btn" id="btn-confirmar-extrato" style="margin-top:14px;">Importar selecionados</button>
  `);

  document.getElementById('btn-confirmar-extrato').addEventListener('click', async ()=>{
    const checks = document.querySelectorAll('.extrato-check');
    let count = 0;
    checks.forEach(chk=>{
      if(!chk.checked) return;
      const i = chk.dataset.idx;
      const l = linhas[i];
      const conta = document.querySelector(`[data-conta="${i}"]`).value;
      const categoria = document.querySelector(`[data-cat="${i}"]`).value;
      STATE.entries.push({
        id: uid(), tipo:'despesa', forma:'debito', valor: l.valor,
        descricao: l.descricao, conta, categoria, data: l.data, criadoEm: Date.now()
      });
      count++;
    });
    await persist();
    closeModal();
    renderAll();
    showToast(`${count} lançamentos importados`);
  });
}

/* ===========================================================
   BIND GERAL POR ABA + BOOTSTRAP
=========================================================== */
function bindTabEvents(){
  if(currentTab==='lancamentos') bindLancEvents();
  if(currentTab==='faturas') bindFaturasEvents();
  if(currentTab==='graficos') bindGraficosEvents();
  if(currentTab==='grupos') bindGruposEvents();
  if(currentTab==='investim') bindInvestimEvents();
  if(currentTab==='ajustes') bindAjustesEvents();
}

(async function init(){
  await loadState();
  renderAll();
})();
