// GustaDoces - backend (Node 22+, sem dependências). Rodar: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_FILE || 'gustadoces.db');
const SECRET = process.env.AUTH_SECRET || 'TROQUE-ESTA-CHAVE';   // <- defina AUTH_SECRET em produção
const r2 = n => Math.round(n * 100) / 100;

db.exec(`
create table if not exists users(id integer primary key,name text,email text unique,pass text,role text default 'customer',phone text,address text,zone_id integer,created text default current_timestamp);
create table if not exists categories(id integer primary key,name text unique);
create table if not exists products(id integer primary key,name text,description text,price real,promo_price real,image text,category_id integer references categories(id),active integer default 1);
create table if not exists zones(id integer primary key,name text unique,fee real);
create table if not exists wallets(user_id integer primary key references users(id),balance real default 0);
create table if not exists wallet_tx(id integer primary key,user_id integer references users(id),amount real,description text,created text default current_timestamp);
create table if not exists orders(id integer primary key autoincrement,user_id integer references users(id),subtotal real,shipping real,discount real default 0,total real,payment text,payment_status text,status text default 'Pedido recebido',address text,zone_id integer,created text default current_timestamp);
create table if not exists order_items(id integer primary key,order_id integer references orders(id),product_id integer,name text,qty integer,unit_price real);
`);

const hash = (p, s = crypto.randomBytes(16).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 32).toString('hex');
const check = (p, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(hash(p, s).split(':')[1], 'hex'), Buffer.from(k, 'hex')); };
const sign = id => { const b = Buffer.from(JSON.stringify({ id, exp: Date.now() + 7 * 864e5 })).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const verify = t => { try { const [b, s] = t.split('.'); if (s !== crypto.createHmac('sha256', SECRET).update(b).digest('base64url')) return null; const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p.id : null; } catch { return null; } };

// seed
if (!db.prepare('select 1 from categories').get()) {
  ['Bolos', 'Doces', 'Chocolates', 'Kits', 'Promoções', 'Outros'].forEach(n => db.prepare('insert into categories(name) values(?)').run(n));
  [['Rosário', 5], ['Bacabeira', 8], ['Santa Rita', 10]].forEach(z => db.prepare('insert into zones(name,fee) values(?,?)').run(...z));
  [['Brigadeiro gourmet', 'Chocolate belga, granulado crocante', 2, null, 2], ['Brownie', 'Úmido, com nozes', 6, 5, 2], ['Bolo de cenoura', 'Cobertura de chocolate (fatia)', 9, null, 1],
   ['Barra de chocolate ao leite', '100g artesanal', 14, null, 3], ['Kit festa 25 doces', 'Brigadeiros, beijinhos e cajuzinhos', 55, 49.9, 4], ['Trufa de maracujá', 'Recheio cremoso', 4.5, null, 3]]
    .forEach(p => db.prepare('insert into products(name,description,price,promo_price,category_id) values(?,?,?,?,?)').run(...p));
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare("insert into users(name,email,pass,role) values('Administrador','admin@gustadoces.com',?,'admin')").run(hash(pw));
  console.log('Admin criado: admin@gustadoces.com /', pw, '(troque a senha! use ADMIN_PASSWORD)');
}

const unit = p => (p.promo_price != null && p.promo_price > 0 ? p.promo_price : p.price);
const getUser = id => db.prepare('select id,name,email,role,phone,address,zone_id from users where id=?').get(id);
const bal = id => (db.prepare('select balance from wallets where user_id=?').get(id) || { balance: 0 }).balance;
// Totais SEMPRE recalculados aqui; o frontend só envia ids e quantidades.
function quote(items, zone_id) {
  if (!Array.isArray(items) || !items.length) throw [400, 'Sacola vazia.'];
  const lines = items.map(i => {
    const p = db.prepare('select * from products where id=? and active=1').get(+i.id), q = Math.floor(+i.qty);
    if (!p || !(q > 0 && q <= 500)) throw [400, 'Item inválido.'];
    return { product_id: p.id, name: p.name, qty: q, unit_price: unit(p), subtotal: r2(unit(p) * q), discount: r2((p.price - unit(p)) * q) };
  });
  const z = db.prepare('select * from zones where id=?').get(+zone_id);
  if (!z) throw [400, 'Selecione uma área de entrega.'];
  const subtotal = r2(lines.reduce((a, l) => a + l.subtotal, 0)), discount = r2(lines.reduce((a, l) => a + l.discount, 0));
  return { lines, subtotal, discount, shipping: z.fee, total: r2(subtotal + z.fee) };
}

const routes = [];
const route = (m, p, auth, fn) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, fn });
// públicas
route('POST', '/api/register', 0, ({ body: b }) => {
  if (!b.name || !/^\S+@\S+\.\S+$/.test(b.email || '') || (b.password || '').length < 6) throw [400, 'Dados inválidos (senha mínima: 6).'];
  try { const id = db.prepare('insert into users(name,email,pass) values(?,?,?)').run(b.name, b.email.toLowerCase(), hash(b.password)).lastInsertRowid;
    db.prepare('insert into wallets(user_id,balance) values(?,0)').run(id); return { token: sign(+id), user: getUser(id) }; } catch (e) { if (Array.isArray(e)) throw e; throw [409, 'E-mail já cadastrado.']; }
});
route('POST', '/api/login', 0, ({ body: b }) => {
  const u = db.prepare('select * from users where email=?').get((b.email || '').toLowerCase());
  if (!u || !check(b.password || '', u.pass)) throw [401, 'E-mail ou senha incorretos.'];
  return { token: sign(u.id), user: getUser(u.id) };
});
route('GET', '/api/catalog', 0, () => ({ categories: db.prepare('select * from categories').all(), products: db.prepare('select * from products where active=1').all(), zones: db.prepare('select * from zones').all() }));
route('POST', '/api/quote', 0, ({ body: b }) => quote(b.items, b.zone_id));
// cliente
route('GET', '/api/me', 1, ({ user }) => ({ user, balance: bal(user.id) }));
route('PUT', '/api/me', 1, ({ user, body: b }) => { db.prepare('update users set name=?,phone=?,address=?,zone_id=? where id=?').run(b.name || user.name, b.phone || null, b.address || null, b.zone_id || null, user.id); return { user: getUser(user.id) }; });
route('GET', '/api/wallet', 1, ({ user }) => ({ balance: bal(user.id), tx: db.prepare('select * from wallet_tx where user_id=? order by id desc').all(user.id) }));
route('GET', '/api/orders', 1, ({ user }) => db.prepare('select * from orders where user_id=? order by id desc').all(user.id).map(o => ({ ...o, items: db.prepare('select * from order_items where order_id=?').all(o.id) })));
route('POST', '/api/orders', 1, ({ user, body: b }) => {
  const q = quote(b.items, b.zone_id);
  if (!b.address || b.address.length < 5) throw [400, 'Informe o endereço de entrega.'];
  if (b.payment !== 'carteira') {   // PIX/cartão: integrar gateway em payments.js (ver README) — nunca aprovar sem confirmação do gateway
    throw [501, 'Gateway de pagamento ainda não configurado para esta forma de pagamento.'];
  }
  db.exec('begin immediate');
  try {
    if (bal(user.id) < q.total) throw [402, 'Saldo insuficiente para realizar esta compra.'];
    const id = db.prepare('insert into orders(user_id,subtotal,shipping,discount,total,payment,payment_status,address,zone_id) values(?,?,?,?,?,?,?,?,?)').run(user.id, q.subtotal, q.shipping, q.discount, q.total, 'Carteira', 'Pago', b.address, +b.zone_id).lastInsertRowid;
    q.lines.forEach(l => db.prepare('insert into order_items(order_id,product_id,name,qty,unit_price) values(?,?,?,?,?)').run(id, l.product_id, l.name, l.qty, l.unit_price));
    db.prepare('update wallets set balance=balance-? where user_id=?').run(q.total, user.id);
    db.prepare('insert into wallet_tx(user_id,amount,description) values(?,?,?)').run(user.id, -q.total, 'Compra #' + id);
    db.exec('commit'); return { order_id: Number(id), balance: bal(user.id), ...q };
  } catch (e) { db.exec('rollback'); throw e; }
});
// admin
const A = (m, p, fn) => route(m, p, 2, fn);
A('GET', '/api/admin/summary', () => {
  const s = (w) => db.prepare(`select count(*) n, coalesce(sum(total),0) t from orders where status!='Cancelado' ${w}`).get();
  return { day: s("and date(created)=date('now')"), month: s("and strftime('%Y-%m',created)=strftime('%Y-%m','now')"), all: s(''),
    pending: db.prepare("select count(*) n from orders where status in ('Pedido recebido','Em preparação')").get().n, products: db.prepare('select count(*) n from products').get().n };
});
A('GET', '/api/admin/orders', () => db.prepare('select o.*,u.name customer from orders o join users u on u.id=o.user_id order by o.id desc').all().map(o => ({ ...o, items: db.prepare('select * from order_items where order_id=?').all(o.id) })));
A('PUT', '/api/admin/orders/:id', ({ params, body: b }) => {
  if (!['Pedido recebido', 'Em preparação', 'Saiu para entrega', 'Entregue', 'Cancelado'].includes(b.status)) throw [400, 'Status inválido.'];
  const o = db.prepare('select * from orders where id=?').get(+params.id); if (!o) throw [404, 'Pedido não encontrado.'];
  if (b.status === 'Cancelado' && o.status !== 'Cancelado' && o.payment === 'Carteira') {   // estorno automático
    db.prepare('update wallets set balance=balance+? where user_id=?').run(o.total, o.user_id);
    db.prepare('insert into wallet_tx(user_id,amount,description) values(?,?,?)').run(o.user_id, o.total, 'Estorno pedido #' + o.id);
  }
  db.prepare('update orders set status=? where id=?').run(b.status, o.id); return { ok: 1 };
});
A('GET', '/api/admin/users', () => db.prepare("select u.id,u.name,u.email,u.phone,u.created,coalesce(w.balance,0) balance from users u left join wallets w on w.user_id=u.id where role='customer'").all());
A('POST', '/api/admin/credit', ({ body: b }) => {
  const v = r2(+b.amount); if (!(v > 0) || !db.prepare('select 1 from users where id=?').get(+b.user_id)) throw [400, 'Dados inválidos.'];
  db.prepare('insert into wallets(user_id,balance) values(?,?) on conflict(user_id) do update set balance=balance+?').run(+b.user_id, v, v);
  db.prepare('insert into wallet_tx(user_id,amount,description) values(?,?,?)').run(+b.user_id, v, 'Crédito adicionado'); return { ok: 1 };
});
A('GET', '/api/admin/products', () => db.prepare('select * from products').all());
const P = b => [b.name, b.description || '', +b.price, b.promo_price ? +b.promo_price : null, b.image || null, +b.category_id || null, b.active === 0 ? 0 : 1];
A('POST', '/api/admin/products', ({ body: b }) => { if (!b.name || !(+b.price >= 0)) throw [400, 'Nome e preço obrigatórios.']; return { id: Number(db.prepare('insert into products(name,description,price,promo_price,image,category_id,active) values(?,?,?,?,?,?,?)').run(...P(b)).lastInsertRowid) }; });
A('PUT', '/api/admin/products/:id', ({ params, body: b }) => { db.prepare('update products set name=?,description=?,price=?,promo_price=?,image=?,category_id=?,active=? where id=?').run(...P(b), +params.id); return { ok: 1 }; });
A('DELETE', '/api/admin/products/:id', ({ params }) => { db.prepare('update products set active=0 where id=?').run(+params.id); return { ok: 1 }; }); // desativa (preserva histórico de pedidos)
A('POST', '/api/admin/categories', ({ body: b }) => ({ id: Number(db.prepare('insert into categories(name) values(?)').run(b.name).lastInsertRowid) }));
A('POST', '/api/admin/zones', ({ body: b }) => ({ id: Number(db.prepare('insert into zones(name,fee) values(?,?)').run(b.name, +b.fee).lastInsertRowid) }));
A('PUT', '/api/admin/zones/:id', ({ params, body: b }) => { db.prepare('update zones set name=?,fee=? where id=?').run(b.name, +b.fee, +params.id); return { ok: 1 }; });
A('DELETE', '/api/admin/zones/:id', ({ params }) => { db.prepare('delete from zones where id=?').run(+params.id); return { ok: 1 }; });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), send = (c, d) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (!url.pathname.startsWith('/api/')) {
    const f = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res);
  }
  try {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e6) throw [413, 'Grande demais.']; }
    const body = raw ? JSON.parse(raw) : {};
    for (const r of routes) {
      const m = r.m === req.method && url.pathname.match(r.re); if (!m) continue;
      let user = null;
      if (r.auth) { const id = verify((req.headers.authorization || '').replace('Bearer ', '')); user = id && getUser(id); if (!user) throw [401, 'Faça login.']; if (r.auth === 2 && user.role !== 'admin') throw [403, 'Acesso restrito.']; }
      return send(200, r.fn({ user, body, params: m.groups || {} }));
    }
    send(404, { error: 'Rota não encontrada.' });
  } catch (e) { Array.isArray(e) ? send(e[0], { error: e[1] }) : (console.error(e), send(500, { error: 'Erro interno.' })); }
}).listen(process.env.PORT || 3000, () => console.log('GustaDoces em http://localhost:' + (process.env.PORT || 3000)));
